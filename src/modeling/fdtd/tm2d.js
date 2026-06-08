/* CPML O(2,4) TM-mode FDTD — strictly follows TM_model2d.m (James Irving, 2005)
   Convolutional PML (Roden & Gedney 2000), 4th-order spatial differences,
   separated interior/PML updates for speed. */
import { C0, EPS0, MU0, createRickerPulse, sourceReceiverPairs, packRadarGram, buildAxis, estimateWork } from "./common.js";

export function simulateTm2d(input, options = {}) {
  /* 1. normalise grid */
  let grid = normalizeCpmlInput(input, options);
  const pairs = sourceReceiverPairs(grid, options);
  const iterations = grid.srcpulse.length;
  const outstep = Math.max(1, Math.round(Number(options.outstep || grid.outstep || 1)));
  const samples = Math.ceil(iterations / outstep);
  const nsrc = pairs.src.length;
  const pairedReceivers = options.fullReceiverGather !== true && pairs.rec.length === pairs.src.length;
  const nrec = pairedReceivers ? 1 : pairs.rec.length;
  const gather = new Float32Array(samples * nrec * nsrc);
  const tout = new Float64Array(samples);
  const srcxArr = new Float32Array(nsrc), srczArr = new Float32Array(nsrc);
  const recxArr = new Float32Array(pairedReceivers ? nsrc : nrec), reczArr = new Float32Array(pairedReceivers ? nsrc : nrec);

  /* 2. CPML coefficients (MATLAB lines 129-206) */
  const coef = computeCpmlCoefficients(grid);
  const work = estimateWork(grid, pairs, iterations);
  const srcI = new Int32Array(nsrc), srcJ = new Int32Array(nsrc);
  const recI = new Int32Array(pairedReceivers ? nsrc : nrec), recJ = new Int32Array(pairedReceivers ? nsrc : nrec);
  for (let s = 0; s < nsrc; s++) {
    const [si, sj] = indexInField(grid.x, grid.z, pairs.src[s][0], pairs.src[s][1]);
    srcI[s] = si; srcJ[s] = sj;
    srcxArr[s] = fieldCoord(grid.x, si); srczArr[s] = fieldCoord(grid.z, sj);
    if (pairedReceivers) {
      const [ri, rj] = indexInField(grid.x, grid.z, pairs.rec[s][0], pairs.rec[s][1]);
      recI[s] = ri; recJ[s] = rj;
      recxArr[s] = fieldCoord(grid.x, ri); reczArr[s] = fieldCoord(grid.z, rj);
    }
  }
  if (!pairedReceivers) {
    for (let r = 0; r < nrec; r++) {
      const [ri, rj] = indexInField(grid.x, grid.z, pairs.rec[r][0], pairs.rec[r][1]);
      recI[r] = ri; recJ[r] = rj;
      recxArr[r] = fieldCoord(grid.x, ri); reczArr[r] = fieldCoord(grid.z, rj);
    }
  }

  const Ey = new Float64Array(grid.nxField * grid.nzField);
  const Hx = new Float64Array(grid.nxField * (grid.nzField + 1));
  const Hz = new Float64Array((grid.nxField + 1) * grid.nzField);
  const Eydiffx = new Float64Array(grid.nxField * grid.nzField);
  const Eydiffz = new Float64Array(grid.nxField * grid.nzField);
  const Hxdiffz = new Float64Array(grid.nxField * grid.nzField);
  const Hzdiffx = new Float64Array(grid.nxField * grid.nzField);
  const PEyx = new Float64Array(grid.nxField * grid.nzField);
  const PEyz = new Float64Array(grid.nxField * grid.nzField);
  const PHx = new Float64Array(grid.nxField * grid.nzField);
  const PHz = new Float64Array(grid.nxField * grid.nzField);

  /* 3. loop over shots */
  for (let s = 0; s < nsrc; s++) {
    const si = srcI[s], sj = srcJ[s];

    /* zero fields (MATLAB lines 222-232) */
    Ey.fill(0); Hx.fill(0); Hz.fill(0);
    Eydiffx.fill(0); Eydiffz.fill(0); Hxdiffz.fill(0); Hzdiffx.fill(0);
    PEyx.fill(0); PEyz.fill(0); PHx.fill(0); PHz.fill(0);

    let outIdx = 0;
    for (let it = 0; it < iterations; it++) {
      /* --- Hx update (MATLAB lines 237-257) --- */
      {
        const i0 = 1, i1 = grid.nxField - 2;
        const j0 = 3, j1 = grid.nzField - 2;
        for (let i = i0; i <= i1; i++) {
          const ki = 2 * i;
          for (let j = j0; j <= j1; j++) {
            const lj = 2 * j - 1;
            const idxF = i * grid.nzField + (j - 1);
            const idxProp = ki * grid.nzProp + lj;

            Eydiffz[i * grid.nzField + (j - 1)] = -Ey[i * grid.nzField + j] + 27 * Ey[i * grid.nzField + (j - 1)] - 27 * Ey[i * grid.nzField + (j - 2)] + Ey[i * grid.nzField + (j - 3)];
            Hx[i * grid.nzField + (j - 1)] -= coef.Dbz[idxProp] * Eydiffz[i * grid.nzField + (j - 1)];
          }
        }
        /* PML Hx */
        applyPmlHfield(Hx, PHx, Eydiffz, grid, coef, 'z');
      }

      /* --- Hz update (MATLAB lines 260-280) --- */
      {
        const i0 = 3, i1 = grid.nxField - 2;
        const j0 = 1, j1 = grid.nzField - 2;
        for (let i = i0; i <= i1; i++) {
          const ki = 2 * i - 1;
          for (let j = j0; j <= j1; j++) {
            const lj = 2 * j;
            const idxProp = ki * grid.nzProp + lj;

            Eydiffx[(i - 1) * grid.nzField + j] = -Ey[i * grid.nzField + j] + 27 * Ey[(i - 1) * grid.nzField + j] - 27 * Ey[(i - 2) * grid.nzField + j] + Ey[(i - 3) * grid.nzField + j];
            Hz[(i - 1) * grid.nzField + j] += coef.Dbx[idxProp] * Eydiffx[(i - 1) * grid.nzField + j];
          }
        }
        applyPmlHfield(Hz, PHz, Eydiffx, grid, coef, 'x');
      }

      /* --- Ey update (MATLAB lines 283-306) --- */
      {
        const i0 = 2, i1 = grid.nxField - 2;
        const j0 = 2, j1 = grid.nzField - 2;
        for (let i = i0; i <= i1; i++) {
          const ki = 2 * i;
          for (let j = j0; j <= j1; j++) {
            const lj = 2 * j;
            const idxProp = ki * grid.nzProp + lj;
            const idxF = i * grid.nzField + j;

            Hxdiffz[idxF] = -Hx[i * grid.nzField + (j + 1)] + 27 * Hx[i * grid.nzField + j] - 27 * Hx[i * grid.nzField + (j - 1)] + Hx[i * grid.nzField + (j - 2)];
            Hzdiffx[idxF] = -Hz[(i + 1) * grid.nzField + j] + 27 * Hz[i * grid.nzField + j] - 27 * Hz[(i - 1) * grid.nzField + j] + Hz[(i - 2) * grid.nzField + j];
            Ey[idxF] = coef.Ca[idxProp] * Ey[idxF] + coef.Cbx[idxProp] * Hzdiffx[idxF] - coef.Cbz[idxProp] * Hxdiffz[idxF];
          }
        }
        applyPmlEfield(Ey, PEyx, PEyz, Hzdiffx, Hxdiffz, grid, coef);
      }

      /* source injection (MATLAB line 311) */
      Ey[si * grid.nzField + sj] += grid.srcpulse[it];

      /* record */
      if (it % outstep === 0) {
        tout[outIdx] = grid.t[it] ?? it * grid.dt;
        for (let r = 0; r < nrec; r++) {
          const recIndex = pairedReceivers ? s : r;
          const value = Ey[recI[recIndex] * grid.nzField + recJ[recIndex]];
          if (!Number.isFinite(value)) throw new Error("TM FDTD diverged (NaN/Inf field value).");
          gather[(s * nrec + r) * samples + outIdx] = value;
        }
        outIdx++;
      }
      if (options.onProgress && (it % Math.max(1, Math.floor(iterations / 20)) === 0 || it === iterations - 1)) {
        options.onProgress({ shot: s + 1, shots: nsrc, iteration: it + 1, iterations, progress: (s + (it + 1) / iterations) / nsrc });
      }
    }
  }

  return {
    mode: "TM_CPML",
    gather,
    data: packRadarGram(gather, samples, nrec, nsrc),
    numTraces: nsrc,
    numSamples: samples,
    tout,
    srcx: srcxArr, srcz: srczArr,
    recx: recxArr, recz: reczArr,
    dtS: grid.dt * outstep,
    dtNs: grid.dt * outstep * 1e9,
    dxM: grid.dx,
    x: Float32Array.from(pairs.src.map(p => p[0])),
    z: Float32Array.from(grid.z),
    work,
    meta: {
      fdtdMode: "TM_CPML",
      x: Float32Array.from(pairs.src.map(p => p[0])),
      timeAxisNs: Float32Array.from(tout, v => v * 1e9),
      sampleRateHz: 1 / (grid.dt * outstep)
    }
  };
}

/* ================================================================
   CPML helpers — exactly matching TM_model2d.m lines 129-206
   ================================================================ */

function normalizeCpmlInput(input, options) {
  const nxProp = input.nx || input.x?.length || 0;
  const nzProp = input.nz || input.z?.length || 0;
  if (nxProp < 5 || nzProp < 5) throw new Error("FDTD grid must be at least 5x5.");

  const npml = Math.max(2, Math.round(Number(options.npml ?? input.npml ?? 10)));
  if (npml >= nxProp / 2 || npml >= nzProp / 2) throw new Error("Too many PML layers for grid.");

  const xProp = Float64Array.from(input.x || buildAxis(nxProp, options.dxM || 0.02));
  const zProp = Float64Array.from(input.z || buildAxis(nzProp, options.dzM || options.dxM || 0.02));
  if (nxProp % 2 !== 1 || nzProp % 2 !== 1) throw new Error("TM FDTD requires odd property-grid dimensions, matching TM_model2d.m.");
  const ep = Float64Array.from(input.ep || input.epsr || []);
  const mu = Float64Array.from(input.mu || input.muField || filled(nxProp * nzProp, 1));
  const sig = Float64Array.from(input.sig || input.sigma || new Float64Array(nxProp * nzProp));
  if (ep.length !== nxProp * nzProp) throw new Error("TM FDTD ep grid size is invalid.");
  if (mu.length !== nxProp * nzProp) throw new Error("TM FDTD mu grid size is invalid.");
  if (sig.length !== nxProp * nzProp) throw new Error("TM FDTD sig grid size is invalid.");
  const dx = 2 * Math.abs(xProp[1] - xProp[0]);
  const dz = 2 * Math.abs(zProp[1] - zProp[0]);

  /* field nodes: half the property nodes (MATLAB lines 86-99) */
  const nxField = (nxProp + 1) >> 1;
  const nzField = (nzProp + 1) >> 1;

  const dt = finitePositive(options.dtS ?? options.dt, stableDt(ep, mu, dx, dz));
  const sourceInput = input.srcpulse || options.srcpulse;
  const samples = Math.max(2, Math.floor(Number(options.iterations || sourceInput?.length || options.samples || 640)));
  const srcpulse = Float64Array.from(sourceInput || createRickerPulse(options.frequencyHz || 500e6, dt, samples));
  const t = input.t || options.t ? Float64Array.from(input.t || options.t) : buildAxis(srcpulse.length, dt);

  return {
    nxProp, nzProp, nxField, nzField, npml,
    x: xProp, z: zProp, dx, dz, dt,
    ep,
    mu,
    sig,
    srcpulse, t, samples,
    defaultAntennaZ: input.defaultAntennaZ,
    defaultStartX: input.defaultStartX,
    defaultEndX: input.defaultEndX
  };
}

function computeCpmlCoefficients(grid) {
  const { nxProp, nzProp, npml, dx, dz, dt, ep, mu } = grid;
  const EP0 = EPS0, MU = MU0;  /* MATLAB lines 81-82 */
  const m = 4, Kxmax = 5, Kzmax = 5, alphaPml = 0;  /* MATLAB lines 135-140 */

  const sigxmax = new Float64Array(ep.length);
  const sigzmax = new Float64Array(ep.length);
  for (let i = 0; i < ep.length; i++) {
    sigxmax[i] = (m + 1) / (150 * Math.PI * Math.sqrt(ep[i]) * dx);
    sigzmax[i] = (m + 1) / (150 * Math.PI * Math.sqrt(ep[i]) * dz);
  }

  /* PML edge indices (MATLAB lines 143-150) */
  const kpmlLin = 2 * npml + 1;
  const kpmlRin = nxProp - (2 * npml + 2) + 1;  /* 0-based */
  const lpmlTin = 2 * npml + 1;
  const lpmlBin = nzProp - (2 * npml + 2) + 1;

  const xdel = new Float64Array(nxProp * nzProp);
  const zdel = new Float64Array(nxProp * nzProp);
  for (let k = 0; k < nxProp; k++) {
    let rx = 0;
    if (k <= kpmlLin) rx = (kpmlLin - k) / (2 * npml);
    else if (k >= kpmlRin) rx = (k - kpmlRin) / (2 * npml);
    for (let l = 0; l < nzProp; l++) {
      xdel[k * nzProp + l] = rx;
      let rz = 0;
      if (l <= lpmlTin) rz = (lpmlTin - l) / (2 * npml);
      else if (l >= lpmlBin) rz = (l - lpmlBin) / (2 * npml);
      zdel[k * nzProp + l] = rz;
    }
  }

  const sigx = new Float64Array(nxProp * nzProp);
  const sigz = new Float64Array(nxProp * nzProp);
  const Kx = new Float64Array(nxProp * nzProp);
  const Kz = new Float64Array(nxProp * nzProp);
  for (let i = 0; i < xdel.length; i++) {
    const xd = xdel[i], zd = zdel[i];
    sigx[i] = sigxmax[i] * Math.pow(xd, m);
    sigz[i] = sigzmax[i] * Math.pow(zd, m);
    Kx[i] = 1 + (Kxmax - 1) * Math.pow(xd, m);
    Kz[i] = 1 + (Kzmax - 1) * Math.pow(zd, m);
  }

  /* update coefficients (MATLAB lines 188-203) */
  const denE = new Float64Array(nxProp * nzProp);
  const Ca  = new Float64Array(nxProp * nzProp);
  const Cbx = new Float64Array(nxProp * nzProp);
  const Cbz = new Float64Array(nxProp * nzProp);
  const Cc  = new Float64Array(nxProp * nzProp);
  const Dbx = new Float64Array(nxProp * nzProp);
  const Dbz = new Float64Array(nxProp * nzProp);
  const Dc  = new Float64Array(nxProp * nzProp);
  const Bx  = new Float64Array(nxProp * nzProp);
  const Bz  = new Float64Array(nxProp * nzProp);
  const Ax  = new Float64Array(nxProp * nzProp);
  const Az  = new Float64Array(nxProp * nzProp);

  for (let i = 0; i < nxProp * nzProp; i++) {
    const s = grid.sig[i], e = Math.max(ep[i], 1e-20), m_ = Math.max(mu[i], 1e-20);
    denE[i] = 1 + dt * s / (2 * e * EP0);
    Ca[i]  = (1 - dt * s / (2 * e * EP0)) / denE[i];
    const inv24dxk = 1 / (24 * dx * Kx[i]);
    const inv24dzk = 1 / (24 * dz * Kz[i]);
    const dtOverE = dt / (e * EP0);
    Cbx[i] = (dtOverE) / (denE[i] * 24 * dx * Kx[i]);
    Cbz[i] = (dtOverE) / (denE[i] * 24 * dz * Kz[i]);
    Cc[i]  = (dtOverE) / denE[i];
    Dbx[i] = dt / (m_ * MU * Kx[i] * 24 * dx);
    Dbz[i] = dt / (m_ * MU * Kz[i] * 24 * dz);
    Dc[i]  = dt / (m_ * MU);
    Bx[i]  = Math.exp(-(sigx[i] / Kx[i] + alphaPml) * (dt / EP0));
    Bz[i]  = Math.exp(-(sigz[i] / Kz[i] + alphaPml) * (dt / EP0));
    const safeDenAx = sigx[i] * Kx[i] + Kx[i] * Kx[i] * alphaPml + 1e-20;
    const safeDenAz = sigz[i] * Kz[i] + Kz[i] * Kz[i] * alphaPml + 1e-20;
    Ax[i]  = (sigx[i] / safeDenAx * (Bx[i] - 1)) / (24 * dx);
    Az[i]  = (sigz[i] / safeDenAz * (Bz[i] - 1)) / (24 * dz);
  }

  return { Ca, Cbx, Cbz, Cc, Dbx, Dbz, Dc, Bx, Bz, Ax, Az, kpmlLin, kpmlRin, lpmlTin, lpmlBin };
}

/* --- field-index to property-index helpers --- */
function indexInField(xProp, zProp, xVal, zVal) {
  /* MATLAB lines 92-100: xEy = xHx = xprop(2:dx:end-1), zEy = zHz = zprop(2:dz:end-1) */
  return [nearestFieldIndex(xProp, xVal), nearestFieldIndex(zProp, zVal)];
}

function nearestFieldIndex(axis, value) {
  const count = Math.max(1, Math.floor((axis.length - 1) / 2));
  let best = 0, dist = Infinity;
  for (let i = 0; i < count; i++) {
    const d = Math.abs(fieldCoord(axis, i) - value);
    if (d < dist) { dist = d; best = i; }
  }
  return best;
}

function fieldCoord(axis, fieldIndex) {
  const propIndex = Math.max(0, Math.min(axis.length - 1, 1 + 2 * fieldIndex));
  return axis[propIndex];
}

/* PML region helpers (MATLAB lines 239-306, split interior/PML) */

function isPml(k, l, c, axis) {
  if (axis === 'x') return k <= c.kpmlLin || k >= c.kpmlRin;
  return l <= c.lpmlTin || l >= c.lpmlBin;
}

function applyPmlHfield(H, PH, diff, grid, c, axis) {
  const { nxField, nzField, nxProp, nzProp } = grid;
  /* wrap Hx-sized dims: Hx = nxField × (nzField+1), PH = nxField × nzField */
  const hCols = axis === 'z' ? nzField : nzField;
  const phCols = nzField;

  if (axis === 'z') {
    /* Hx PML (MATLAB lines 254-257) */
    for (let i = 0; i < nxField; i++) {
      const ki = 2 * i;
      for (let j = 0; j < nzField; j++) {
        const lj = 2 * j - 1 + 1;  /* +1 for Hx offset: 2*j-1 property index */
        const idxProp = ki * nzProp + lj;
        if (!isPml(ki, lj, c, axis)) continue;
        const idxPH = i * nzField + j;
        PH[idxPH] = c[axis === 'z' ? 'Bz' : 'Bx'][idxProp] * PH[idxPH] + c[axis === 'z' ? 'Az' : 'Ax'][idxProp] * diff[idxPH];
        H[i * hCols + j] -= c.Dc[idxProp] * PH[idxPH];
      }
    }
  } else {
    /* Hz PML (MATLAB lines 277-280) */
    for (let i = 0; i < nxField; i++) {
      const ki = 2 * i - 1 + 1;  /* +1 for Hz offset */
      for (let j = 0; j < nzField; j++) {
        const lj = 2 * j;
        const idxProp = ki * nzProp + lj;
        if (!isPml(ki, lj, c, axis)) continue;
        const idxPH = i * nzField + j;
        PH[idxPH] = c.Bx[idxProp] * PH[idxPH] + c.Ax[idxProp] * diff[idxPH];
        H[(i + 1) * nzField + j] += c.Dc[idxProp] * PH[idxPH];
      }
    }
  }
}

function applyPmlEfield(Ey, PEyx, PEyz, HzDiff, HxDiff, grid, c) {
  const { nxField, nzField, nxProp, nzProp } = grid;
  for (let i = 0; i < nxField; i++) {
    const ki = 2 * i;
    for (let j = 0; j < nzField; j++) {
      const lj = 2 * j;
      const idxProp = ki * nzProp + lj;
      const kml = ki <= c.kpmlLin || ki >= c.kpmlRin;
      const lml = lj <= c.lpmlTin || lj >= c.lpmlBin;
      if (!kml && !lml) continue;
      const idxF = i * nzField + j;
      PEyx[idxF] = c.Bx[idxProp] * PEyx[idxF] + c.Ax[idxProp] * HzDiff[idxF];
      PEyz[idxF] = c.Bz[idxProp] * PEyz[idxF] + c.Az[idxProp] * HxDiff[idxF];
      Ey[idxF] += c.Cc[idxProp] * (PEyx[idxF] - PEyz[idxF]);
    }
  }
}

function filled(n, value) {
  const out = new Float64Array(n);
  out.fill(value);
  return out;
}

function finitePositive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function stableDt(ep, mu, dx, dz) {
  let cmax = 0;
  for (let i = 0; i < ep.length; i++) cmax = Math.max(cmax, C0 / Math.sqrt(Math.max(ep[i] * (mu[i] || 1), 1e-9)));
  return 0.45 / (cmax * Math.sqrt(1 / (dx * dx) + 1 / (dz * dz)));
}
