import argparse
import json
import math
import struct
import sys
import time


def load_optional_runtime():
    try:
        import numpy as np
    except Exception as exc:
        return None, None, f"NumPy is not available: {exc}"
    try:
        import numba
    except Exception as exc:
        return np, None, f"Numba is not available: {exc}"
    return np, numba, ""


np, numba, runtime_error = load_optional_runtime()


def print_capabilities():
    available = np is not None and numba is not None
    payload = {
        "available": available,
        "backend": "python-numba-cpu" if available else "",
        "error": "" if available else runtime_error,
        "numpy": getattr(np, "__version__", None) if np is not None else None,
        "numba": getattr(numba, "__version__", None) if numba is not None else None,
    }
    print(json.dumps(payload, ensure_ascii=False))


if np is not None and numba is not None:
    njit = numba.njit(cache=True)
else:
    def njit(fn=None, **_kwargs):
        if fn is None:
            return lambda wrapped: wrapped
        return fn


C0 = 299792458.0
EPS0 = 8.8541878176e-12
MU0 = 1.2566370614e-6


def emit_progress(progress, shot=0, shots=1, iteration=0, iterations=1, stage="running"):
    print(json.dumps({
        "progress": float(progress),
        "shot": int(shot),
        "shots": int(shots),
        "iteration": int(iteration),
        "iterations": int(iterations),
        "stage": stage,
    }), flush=True)


def read_bundle(path):
    with open(path, "rb") as fh:
        raw = fh.read()
    if len(raw) < 4:
        raise RuntimeError("Invalid FDTD bundle.")
    header_len = struct.unpack_from("<I", raw, 0)[0]
    header = json.loads(raw[4:4 + header_len].decode("utf-8"))
    offset = 4 + header_len
    arrays = {}
    dtype_map = {"f32": np.float32, "f64": np.float64}
    for spec in header.get("arrays", []):
        dtype = dtype_map.get(spec.get("dtype"), np.float32)
        count = int(spec.get("length", 0))
        byte_len = int(spec.get("byteLength", count * np.dtype(dtype).itemsize))
        arrays[spec["name"]] = np.frombuffer(raw, dtype=dtype, count=count, offset=offset).copy()
        offset += byte_len
    return header, arrays


def axis(count, step, offset=0.0):
    return offset + np.arange(count, dtype=np.float64) * step


def create_ricker(frequency_hz, dt, samples):
    out = np.empty(samples, dtype=np.float64)
    t0 = 1.5 / frequency_hz
    for i in range(samples):
        a = math.pi * frequency_hz * (i * dt - t0)
        out[i] = (1.0 - 2.0 * a * a) * math.exp(-a * a)
    return out


def stable_dt(ep, mu, dx, dz):
    cmax = C0 / math.sqrt(max(float(np.min(ep * np.maximum(mu, 1e-9))), 1e-9))
    return 0.45 / (cmax * math.sqrt(1.0 / (dx * dx) + 1.0 / (dz * dz)))


def source_receiver_pairs(x, z, npml, options, defaults):
    default_z = float(options.get("antennaZ", defaults.get("defaultAntennaZ", z[min(len(z) - 2, max(1, int(round(npml + 1))))])))
    offset = float(options.get("receiverOffsetM", options.get("receiverOffset", 0.317)))
    start = float(options.get("startX", defaults.get("defaultStartX", x[min(len(x) - 1, max(0, int(npml + 2)))])))
    end_default_idx = min(len(x) - 1, max(0, len(x) - int(npml) - 3))
    end = float(options.get("endX", defaults.get("defaultEndX", x[end_default_idx] - offset)))
    count = max(1, int(options.get("traceCount", options.get("numTraces", min(80, max(1, len(x) - 2 * int(npml) - 4))))))
    src = np.empty((count, 2), dtype=np.float64)
    rec = np.empty((count, 2), dtype=np.float64)
    for i in range(count):
        f = 0.5 if count == 1 else i / (count - 1)
        sx = start + (end - start) * f
        src[i, 0] = sx
        src[i, 1] = default_z
        rec[i, 0] = sx + offset
        rec[i, 1] = default_z
    return src, rec


def nearest_index(values, value):
    return int(np.argmin(np.abs(values - value)))


def field_coord(axis_values, field_index):
    idx = max(0, min(len(axis_values) - 1, 1 + 2 * int(field_index)))
    return float(axis_values[idx])


def nearest_field_index(axis_values, value):
    count = max(1, (len(axis_values) - 1) // 2)
    best = 0
    dist = float("inf")
    for i in range(count):
        d = abs(field_coord(axis_values, i) - value)
        if d < dist:
            dist = d
            best = i
    return best


def compute_cpml_coefficients(ep, mu, sig, nx_prop, nz_prop, npml, dx, dz, dt):
    m_order = 4.0
    kx_max = 5.0
    kz_max = 5.0
    alpha_pml = 0.0
    sigxmax = (m_order + 1.0) / (150.0 * math.pi * np.sqrt(np.maximum(ep, 1e-20)) * dx)
    sigzmax = (m_order + 1.0) / (150.0 * math.pi * np.sqrt(np.maximum(ep, 1e-20)) * dz)
    kpml_lin = 2 * npml + 1
    kpml_rin = nx_prop - (2 * npml + 2) + 1
    lpml_tin = 2 * npml + 1
    lpml_bin = nz_prop - (2 * npml + 2) + 1
    xdel = np.zeros(nx_prop * nz_prop, dtype=np.float64)
    zdel = np.zeros(nx_prop * nz_prop, dtype=np.float64)
    for k in range(nx_prop):
        rx = 0.0
        if k <= kpml_lin:
            rx = (kpml_lin - k) / (2.0 * npml)
        elif k >= kpml_rin:
            rx = (k - kpml_rin) / (2.0 * npml)
        for l in range(nz_prop):
            idx = k * nz_prop + l
            rz = 0.0
            if l <= lpml_tin:
                rz = (lpml_tin - l) / (2.0 * npml)
            elif l >= lpml_bin:
                rz = (l - lpml_bin) / (2.0 * npml)
            xdel[idx] = rx
            zdel[idx] = rz
    sigx = sigxmax * np.power(xdel, m_order)
    sigz = sigzmax * np.power(zdel, m_order)
    kx = 1.0 + (kx_max - 1.0) * np.power(xdel, m_order)
    kz = 1.0 + (kz_max - 1.0) * np.power(zdel, m_order)
    e = np.maximum(ep, 1e-20)
    m = np.maximum(mu, 1e-20)
    den_e = 1.0 + dt * sig / (2.0 * e * EPS0)
    ca = (1.0 - dt * sig / (2.0 * e * EPS0)) / den_e
    dt_over_e = dt / (e * EPS0)
    cbx = dt_over_e / (den_e * 24.0 * dx * kx)
    cbz = dt_over_e / (den_e * 24.0 * dz * kz)
    cc = dt_over_e / den_e
    dbx = dt / (m * MU0 * kx * 24.0 * dx)
    dbz = dt / (m * MU0 * kz * 24.0 * dz)
    dc = dt / (m * MU0)
    bx = np.exp(-(sigx / kx + alpha_pml) * (dt / EPS0))
    bz = np.exp(-(sigz / kz + alpha_pml) * (dt / EPS0))
    ax = (sigx / (sigx * kx + kx * kx * alpha_pml + 1e-20) * (bx - 1.0)) / (24.0 * dx)
    az = (sigz / (sigz * kz + kz * kz * alpha_pml + 1e-20) * (bz - 1.0)) / (24.0 * dz)
    return ca, cbx, cbz, cc, dbx, dbz, dc, bx, bz, ax, az, kpml_lin, kpml_rin, lpml_tin, lpml_bin


@njit
def tm_shot(nx_field, nz_field, nx_prop, nz_prop, src_i, src_j, rec_i, rec_j, srcpulse, t, outstep,
            ca, cbx, cbz, cc, dbx, dbz, dc, bx, bz, ax, az, kpml_lin, kpml_rin, lpml_tin, lpml_bin,
            ey, hx, hz, eydiffx, eydiffz, hxdiffz, hzdiffx, peyx, peyz, phx, phz, out_data, out_offset, tout):
    for i in range(ey.size):
        ey[i] = 0.0
        eydiffx[i] = 0.0
        eydiffz[i] = 0.0
        hxdiffz[i] = 0.0
        hzdiffx[i] = 0.0
        peyx[i] = 0.0
        peyz[i] = 0.0
        phx[i] = 0.0
        phz[i] = 0.0
    for i in range(hx.size):
        hx[i] = 0.0
    for i in range(hz.size):
        hz[i] = 0.0

    out_idx = 0
    iterations = srcpulse.size
    for it in range(iterations):
        for i in range(1, nx_field - 1):
            ki = 2 * i
            for j in range(3, nz_field - 1):
                lj = 2 * j - 1
                idx_f = i * nz_field + (j - 1)
                idx_prop = ki * nz_prop + lj
                eydiffz[idx_f] = -ey[i * nz_field + j] + 27.0 * ey[i * nz_field + (j - 1)] - 27.0 * ey[i * nz_field + (j - 2)] + ey[i * nz_field + (j - 3)]
                hx[i * nz_field + (j - 1)] -= dbz[idx_prop] * eydiffz[idx_f]
        for i in range(nx_field):
            ki = 2 * i
            for j in range(nz_field):
                lj = 2 * j
                if not (lj <= lpml_tin or lj >= lpml_bin):
                    continue
                idx_prop = ki * nz_prop + lj
                idx_ph = i * nz_field + j
                phx[idx_ph] = bz[idx_prop] * phx[idx_ph] + az[idx_prop] * eydiffz[idx_ph]
                hx[i * nz_field + j] -= dc[idx_prop] * phx[idx_ph]

        for i in range(3, nx_field - 1):
            ki = 2 * i - 1
            for j in range(1, nz_field - 1):
                lj = 2 * j
                idx_prop = ki * nz_prop + lj
                idx_f = (i - 1) * nz_field + j
                eydiffx[idx_f] = -ey[i * nz_field + j] + 27.0 * ey[(i - 1) * nz_field + j] - 27.0 * ey[(i - 2) * nz_field + j] + ey[(i - 3) * nz_field + j]
                hz[idx_f] += dbx[idx_prop] * eydiffx[idx_f]
        for i in range(nx_field):
            ki = 2 * i
            for j in range(nz_field):
                lj = 2 * j
                if not (ki <= kpml_lin or ki >= kpml_rin):
                    continue
                idx_prop = ki * nz_prop + lj
                idx_ph = i * nz_field + j
                phz[idx_ph] = bx[idx_prop] * phz[idx_ph] + ax[idx_prop] * eydiffx[idx_ph]
                hz[(i + 1) * nz_field + j] += dc[idx_prop] * phz[idx_ph]

        for i in range(2, nx_field - 1):
            ki = 2 * i
            for j in range(2, nz_field - 1):
                lj = 2 * j
                idx_prop = ki * nz_prop + lj
                idx_f = i * nz_field + j
                hxdiffz[idx_f] = -hx[i * nz_field + (j + 1)] + 27.0 * hx[i * nz_field + j] - 27.0 * hx[i * nz_field + (j - 1)] + hx[i * nz_field + (j - 2)]
                hzdiffx[idx_f] = -hz[(i + 1) * nz_field + j] + 27.0 * hz[i * nz_field + j] - 27.0 * hz[(i - 1) * nz_field + j] + hz[(i - 2) * nz_field + j]
                ey[idx_f] = ca[idx_prop] * ey[idx_f] + cbx[idx_prop] * hzdiffx[idx_f] - cbz[idx_prop] * hxdiffz[idx_f]
        for i in range(nx_field):
            ki = 2 * i
            for j in range(nz_field):
                lj = 2 * j
                kml = ki <= kpml_lin or ki >= kpml_rin
                lml = lj <= lpml_tin or lj >= lpml_bin
                if not kml and not lml:
                    continue
                idx_prop = ki * nz_prop + lj
                idx_f = i * nz_field + j
                peyx[idx_f] = bx[idx_prop] * peyx[idx_f] + ax[idx_prop] * hzdiffx[idx_f]
                peyz[idx_f] = bz[idx_prop] * peyz[idx_f] + az[idx_prop] * hxdiffz[idx_f]
                ey[idx_f] += cc[idx_prop] * (peyx[idx_f] - peyz[idx_f])

        ey[src_i * nz_field + src_j] += srcpulse[it]
        if it % outstep == 0:
            if out_offset == 0:
                tout[out_idx] = t[it]
            value = ey[rec_i * nz_field + rec_j]
            if not math.isfinite(value):
                return 1
            out_data[out_offset + out_idx] = value
            out_idx += 1
    return 0


@njit
def te_shot(nx, nz, src_idx, rec_idx, srcpulse, t, outstep, ep, mu, sig, damping, dx, dz, dt, ex, ez, hy, out_data, out_offset, tout):
    for i in range(ex.size):
        ex[i] = 0.0
        ez[i] = 0.0
        hy[i] = 0.0
    out_idx = 0
    for it in range(srcpulse.size):
        for ix in range(nx - 1):
            for iz in range(nz - 1):
                i = ix * nz + iz
                m = max(mu[i] * MU0, 1e-20)
                curl = (ez[i + nz] - ez[i]) / dx - (ex[i + 1] - ex[i]) / dz
                hy[i] += dt / m * curl
                hy[i] *= damping[i]
        for ix in range(1, nx - 1):
            for iz in range(1, nz - 1):
                i = ix * nz + iz
                eps = max(ep[i] * EPS0, 1e-20)
                sigma = max(sig[i], 0.0)
                loss_a = (1.0 - sigma * dt / (2.0 * eps)) / (1.0 + sigma * dt / (2.0 * eps))
                loss_b = dt / eps / (1.0 + sigma * dt / (2.0 * eps))
                ex[i] = (loss_a * ex[i] + loss_b * (hy[i] - hy[i - 1]) / dz) * damping[i]
                ez[i] = (loss_a * ez[i] - loss_b * (hy[i] - hy[i - nz]) / dx) * damping[i]
        ez[src_idx] += srcpulse[it]
        if it % outstep == 0:
            if out_offset == 0:
                tout[out_idx] = t[it]
            value = ez[rec_idx]
            if not math.isfinite(value):
                return 1
            out_data[out_offset + out_idx] = value
            out_idx += 1
    return 0


def simulate_tm(header, arrays):
    grid = header["grid"]
    options = header.get("fdtd", {})
    nx_prop = int(grid["nx"])
    nz_prop = int(grid["nz"])
    npml = max(2, int(options.get("npml", grid.get("npml", 10))))
    x = arrays["x"].astype(np.float64)
    z = arrays["z"].astype(np.float64)
    ep = arrays["ep"].astype(np.float64)
    sig = arrays["sig"].astype(np.float64)
    mu = arrays["mu"].astype(np.float64)
    dx = 2.0 * abs(float(x[1] - x[0]))
    dz = 2.0 * abs(float(z[1] - z[0]))
    dt = float(options.get("dtS", options.get("dt", stable_dt(ep, mu, dx, dz))))
    iterations = max(2, int(options.get("iterations", options.get("samples", 640))))
    srcpulse = arrays.get("srcpulse")
    if srcpulse is None:
        srcpulse = create_ricker(float(options.get("frequencyHz", 500e6)), dt, iterations)
    else:
        srcpulse = srcpulse.astype(np.float64)
        iterations = len(srcpulse)
    t = axis(iterations, dt)
    outstep = max(1, int(options.get("outstep", 1)))
    samples = int(math.ceil(iterations / outstep))
    src, rec = source_receiver_pairs(x, z, npml, options, grid)
    shots = len(src)
    nx_field = (nx_prop + 1) >> 1
    nz_field = (nz_prop + 1) >> 1
    ca, cbx, cbz, cc, dbx, dbz, dc, bx, bz, ax, az, kpml_lin, kpml_rin, lpml_tin, lpml_bin = compute_cpml_coefficients(ep, mu, sig, nx_prop, nz_prop, npml, dx, dz, dt)
    data = np.empty(shots * samples, dtype=np.float32)
    tout = np.empty(samples, dtype=np.float64)
    srcx = np.empty(shots, dtype=np.float32)
    srcz = np.empty(shots, dtype=np.float32)
    recx = np.empty(shots, dtype=np.float32)
    recz = np.empty(shots, dtype=np.float32)
    ey = np.empty(nx_field * nz_field, dtype=np.float64)
    hx = np.empty(nx_field * (nz_field + 1), dtype=np.float64)
    hz = np.empty((nx_field + 1) * nz_field, dtype=np.float64)
    work = np.empty(nx_field * nz_field, dtype=np.float64)
    eydiffx = work.copy()
    eydiffz = work.copy()
    hxdiffz = work.copy()
    hzdiffx = work.copy()
    peyx = work.copy()
    peyz = work.copy()
    phx = work.copy()
    phz = work.copy()
    emit_progress(0.0, 0, shots, 0, iterations, "compiled")
    for shot in range(shots):
        si = nearest_field_index(x, src[shot, 0])
        sj = nearest_field_index(z, src[shot, 1])
        ri = nearest_field_index(x, rec[shot, 0])
        rj = nearest_field_index(z, rec[shot, 1])
        srcx[shot] = field_coord(x, si)
        srcz[shot] = field_coord(z, sj)
        recx[shot] = field_coord(x, ri)
        recz[shot] = field_coord(z, rj)
        status = tm_shot(nx_field, nz_field, nx_prop, nz_prop, si, sj, ri, rj, srcpulse, t, outstep,
                         ca, cbx, cbz, cc, dbx, dbz, dc, bx, bz, ax, az, kpml_lin, kpml_rin, lpml_tin, lpml_bin,
                         ey, hx, hz, eydiffx, eydiffz, hxdiffz, hzdiffx, peyx, peyz, phx, phz, data, shot * samples, tout)
        if status:
            raise RuntimeError("TM FDTD diverged (NaN/Inf field value).")
        emit_progress((shot + 1) / shots, shot + 1, shots, iterations, iterations)
    return build_result("TM_CPML", data, shots, samples, tout, srcx, srcz, recx, recz, dt * outstep, dx, x, z)


def simulate_te(header, arrays):
    grid = header["grid"]
    options = header.get("fdtd", {})
    nx = int(grid["nx"])
    nz = int(grid["nz"])
    npml = max(0, int(options.get("npml", grid.get("npml", 10))))
    x = arrays["x"].astype(np.float64)
    z = arrays["z"].astype(np.float64)
    ep = arrays["ep"].astype(np.float64)
    sig = arrays["sig"].astype(np.float64)
    mu = arrays["mu"].astype(np.float64)
    dx = abs(float(x[1] - x[0]))
    dz = abs(float(z[1] - z[0]))
    dt = float(options.get("dtS", options.get("dt", stable_dt(ep, mu, dx, dz))))
    iterations = max(2, int(options.get("iterations", options.get("samples", 640))))
    srcpulse = arrays.get("srcpulse")
    if srcpulse is None:
        srcpulse = create_ricker(float(options.get("frequencyHz", 500e6)), dt, iterations)
    else:
        srcpulse = srcpulse.astype(np.float64)
        iterations = len(srcpulse)
    t = axis(iterations, dt)
    outstep = max(1, int(options.get("outstep", 1)))
    samples = int(math.ceil(iterations / outstep))
    src, rec = source_receiver_pairs(x, z, npml, options, grid)
    shots = len(src)
    damping = np.ones(nx * nz, dtype=np.float64)
    for ix in range(nx):
        left = max(0.0, (npml - ix) / npml) if npml else 0.0
        right = max(0.0, (ix - (nx - npml - 1)) / npml) if npml else 0.0
        dxr = max(left, right)
        for iz in range(nz):
            top = max(0.0, (npml - iz) / npml) if npml else 0.0
            bottom = max(0.0, (iz - (nz - npml - 1)) / npml) if npml else 0.0
            damping[ix * nz + iz] = math.exp(-3.2 * max(dxr, top, bottom) ** 2)
    data = np.empty(shots * samples, dtype=np.float32)
    tout = np.empty(samples, dtype=np.float64)
    srcx = np.empty(shots, dtype=np.float32)
    srcz = np.empty(shots, dtype=np.float32)
    recx = np.empty(shots, dtype=np.float32)
    recz = np.empty(shots, dtype=np.float32)
    ex = np.empty(nx * nz, dtype=np.float64)
    ez = np.empty(nx * nz, dtype=np.float64)
    hy = np.empty(nx * nz, dtype=np.float64)
    emit_progress(0.0, 0, shots, 0, iterations, "compiled")
    for shot in range(shots):
        si = nearest_index(x, src[shot, 0])
        sj = nearest_index(z, src[shot, 1])
        ri = nearest_index(x, rec[shot, 0])
        rj = nearest_index(z, rec[shot, 1])
        src_idx = si * nz + sj
        rec_idx = ri * nz + rj
        srcx[shot] = x[si]
        srcz[shot] = z[sj]
        recx[shot] = x[ri]
        recz[shot] = z[rj]
        status = te_shot(nx, nz, src_idx, rec_idx, srcpulse, t, outstep, ep, mu, sig, damping, dx, dz, dt, ex, ez, hy, data, shot * samples, tout)
        if status:
            raise RuntimeError("TE FDTD diverged (NaN/Inf field value).")
        emit_progress((shot + 1) / shots, shot + 1, shots, iterations, iterations)
    return build_result("TE", data, shots, samples, tout, srcx, srcz, recx, recz, dt * outstep, dx, x, z)


def build_result(mode, data, shots, samples, tout, srcx, srcz, recx, recz, dt_s, dx_m, x_axis, z_axis):
    return {
        "mode": mode,
        "backend": "python-numba-cpu",
        "data": data.astype(np.float32).tolist(),
        "numTraces": int(shots),
        "numSamples": int(samples),
        "tout": tout.tolist(),
        "srcx": srcx.tolist(),
        "srcz": srcz.tolist(),
        "recx": recx.tolist(),
        "recz": recz.tolist(),
        "dtS": float(dt_s),
        "dtNs": float(dt_s * 1e9),
        "dxM": float(dx_m),
        "x": srcx.tolist(),
        "z": z_axis.astype(np.float32).tolist(),
        "work": {"shots": int(shots), "iterations": int(samples), "cells": int(len(x_axis) * len(z_axis))},
        "meta": {
            "fdtdMode": mode,
            "x": srcx.tolist(),
            "timeAxisNs": (tout * 1e9).astype(np.float32).tolist(),
            "sampleRateHz": float(1.0 / dt_s) if dt_s > 0 else 0.0,
        },
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--capabilities", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--output")
    args = parser.parse_args()
    if args.capabilities:
        print_capabilities()
        return 0
    if np is None or numba is None:
        print(runtime_error, file=sys.stderr)
        return 2
    if not args.input or not args.output:
        print("Missing --input or --output", file=sys.stderr)
        return 2
    started = time.time()
    header, arrays = read_bundle(args.input)
    mode = str(header.get("mode", "tm")).lower()
    result = simulate_te(header, arrays) if mode == "te" else simulate_tm(header, arrays)
    result["elapsedSec"] = time.time() - started
    with open(args.output, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False)
    emit_progress(1.0, result["numTraces"], result["numTraces"], result["numSamples"], result["numSamples"], "done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
