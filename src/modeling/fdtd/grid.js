import { fft, nextPow2 } from "../../processing/algorithms.js";

export function buildAxis(count, step, offset = 0) {
  const axis = new Float32Array(Math.max(0, Math.floor(count)));
  for (let i = 0; i < axis.length; i++) axis[i] = offset + i * step;
  return axis;
}

export function estimateGridSpacing(epmax, mumax, srcpulse, t, threshold = 0.02) {
  const c0 = 299792458;
  const ep = Math.max(Number(epmax) || 1, Number.EPSILON);
  const mu = Math.max(Number(mumax) || 1, Number.EPSILON);
  const pulse = Float64Array.from(srcpulse || [0], Number);
  if (!t || t.length < 2) throw new Error("estimateGridSpacing: t must contain at least two samples.");
  const dt = Math.abs(Number(t[1]) - Number(t[0]));
  const n = nextPow2(Math.max(2, pulse.length));
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let mean = 0;
  for (const v of pulse) mean += Number.isFinite(v) ? v : 0;
  mean /= Math.max(1, pulse.length);
  for (let i = 0; i < pulse.length; i++) re[i] = (Number.isFinite(pulse[i]) ? pulse[i] : 0) - mean;
  fft(re, im);
  let maxSpec = 0;
  const spec = new Float64Array(Math.floor(n / 2) + 1);
  for (let i = 0; i < spec.length; i++) {
    spec[i] = Math.hypot(re[i], im[i]);
    if (spec[i] > maxSpec) maxSpec = spec[i];
  }
  let fmax = 1 / (10 * dt);
  if (maxSpec > 0) {
    for (let i = 0; i < spec.length; i++) {
      if (spec[i] / maxSpec >= threshold) fmax = i / (n * dt);
    }
  }
  fmax = Math.max(fmax, Number.EPSILON);
  const vmin = c0 / Math.sqrt(ep * mu);
  const wlmin = vmin / fmax;
  return { dx: wlmin / 10, wlmin, fmax };
}

export function gridInterp(field, x, z, xq, zq, method = "linear") {
  const src = normalizeGrid(field, x.length, z.length);
  const out = new Float32Array(xq.length * zq.length);
  const useNearest = String(method).toLowerCase() === "nearest";
  for (let ix = 0; ix < xq.length; ix++) {
    const xp = Number(xq[ix]);
    const xi = lowerBound(x, xp);
    const x0 = Math.max(0, Math.min(x.length - 1, xi));
    const x1 = Math.max(0, Math.min(x.length - 1, xi + 1));
    const fx = x1 === x0 ? 0 : (xp - x[x0]) / (x[x1] - x[x0]);
    for (let iz = 0; iz < zq.length; iz++) {
      const zp = Number(zq[iz]);
      const zi = lowerBound(z, zp);
      const z0 = Math.max(0, Math.min(z.length - 1, zi));
      const z1 = Math.max(0, Math.min(z.length - 1, zi + 1));
      const fz = z1 === z0 ? 0 : (zp - z[z0]) / (z[z1] - z[z0]);
      if (useNearest) {
        const nx = Math.abs(xp - x[x0]) <= Math.abs(xp - x[x1]) ? x0 : x1;
        const nz = Math.abs(zp - z[z0]) <= Math.abs(zp - z[z1]) ? z0 : z1;
        out[ix * zq.length + iz] = src[nx * z.length + nz];
      } else {
        const v00 = src[x0 * z.length + z0];
        const v10 = src[x1 * z.length + z0];
        const v01 = src[x0 * z.length + z1];
        const v11 = src[x1 * z.length + z1];
        const vx0 = v00 * (1 - fx) + v10 * fx;
        const vx1 = v01 * (1 - fx) + v11 * fx;
        out[ix * zq.length + iz] = vx0 * (1 - fz) + vx1 * fz;
      }
    }
  }
  return out;
}

export function padGrid(field, x, z, npad = 1) {
  const pad = Math.max(0, Math.round(Number(npad) || 0));
  const nx = x.length;
  const nz = z.length;
  const src = normalizeGrid(field, nx, nz);
  if (!pad) return { data: new Float32Array(src), x: Float32Array.from(x), z: Float32Array.from(z), nx, nz };
  const nxp = nx + 2 * pad;
  const nzp = nz + 2 * pad;
  const out = new Float32Array(nxp * nzp);
  for (let ix = 0; ix < nxp; ix++) {
    const sx = Math.max(0, Math.min(nx - 1, ix - pad));
    for (let iz = 0; iz < nzp; iz++) {
      const sz = Math.max(0, Math.min(nz - 1, iz - pad));
      out[ix * nzp + iz] = src[sx * nz + sz];
    }
  }
  const dx = x.length > 1 ? x[1] - x[0] : 1;
  const dz = z.length > 1 ? z[1] - z[0] : 1;
  return {
    data: out,
    x: buildAxis(nxp, dx, x[0] - pad * dx),
    z: buildAxis(nzp, dz, z[0] - pad * dz),
    nx: nxp,
    nz: nzp
  };
}

export function depthMajorToXMajor(field, nx, nz) {
  const out = new Float32Array(nx * nz);
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) out[ix * nz + iz] = field[iz * nx + ix];
  return out;
}

export function xMajorToDepthMajor(field, nx, nz) {
  const out = new Float32Array(nx * nz);
  for (let ix = 0; ix < nx; ix++) for (let iz = 0; iz < nz; iz++) out[iz * nx + ix] = field[ix * nz + iz];
  return out;
}

function normalizeGrid(field, nx, nz) {
  const data = field?.data || field;
  if (!data || data.length !== nx * nz) throw new Error("grid size does not match coordinate lengths.");
  return data;
}

function lowerBound(axis, value) {
  if (value <= axis[0]) return 0;
  for (let i = 0; i < axis.length - 1; i++) if (axis[i + 1] >= value) return i;
  return axis.length - 2;
}

