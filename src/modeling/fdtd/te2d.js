import { EPS0, MU0, buildPmlDamping, estimateWork, nearestIndex, normalizeFdtdInput, packRadarGram, sourceReceiverPairs } from "./common.js";

export function simulateTe2d(input, options = {}) {
  const grid = normalizeFdtdInput(input, options);
  const pairs = sourceReceiverPairs(grid, options);
  const iterations = grid.srcpulse.length;
  const samples = Math.ceil(iterations / grid.outstep);
  const nrec = pairs.rec.length;
  const nsrc = pairs.src.length;
  const gather = new Float32Array(samples * nrec * nsrc);
  const tout = new Float64Array(samples);
  const damping = buildPmlDamping(grid.nx, grid.nz, grid.npml, options.pmlStrength || 3.2);
  const srcx = new Float32Array(nsrc), srcz = new Float32Array(nsrc);
  const recx = new Float32Array(nrec), recz = new Float32Array(nrec);
  const work = estimateWork(grid, pairs, iterations);
  for (let shot = 0; shot < nsrc; shot++) {
    const Ex = new Float64Array(grid.nx * grid.nz);
    const Ez = new Float64Array(grid.nx * grid.nz);
    const Hy = new Float64Array(grid.nx * grid.nz);
    const si = nearestIndex(grid.x, pairs.src[shot][0]);
    const sj = nearestIndex(grid.z, pairs.src[shot][1]);
    srcx[shot] = grid.x[si];
    srcz[shot] = grid.z[sj];
    const recIndex = pairs.rec.map((r, i) => {
      const ri = nearestIndex(grid.x, r[0]);
      const rj = nearestIndex(grid.z, r[1]);
      recx[i] = grid.x[ri];
      recz[i] = grid.z[rj];
      return ri * grid.nz + rj;
    });
    let out = 0;
    for (let it = 0; it < iterations; it++) {
      updateTeMagnetic(Ex, Ez, Hy, grid, damping);
      updateTeElectric(Ex, Ez, Hy, grid, damping);
      const sidx = si * grid.nz + sj;
      Ez[sidx] += grid.srcpulse[it];
      if (it % grid.outstep === 0) {
        tout[out] = grid.t[it] ?? it * grid.dt;
        for (let r = 0; r < nrec; r++) gather[(shot * nrec + r) * samples + out] = Ez[recIndex[r]];
        out++;
      }
      if (options.onProgress && (it % Math.max(1, Math.floor(iterations / 20)) === 0 || it === iterations - 1)) {
        options.onProgress({ shot: shot + 1, shots: nsrc, iteration: it + 1, iterations, progress: (shot + (it + 1) / iterations) / nsrc });
      }
    }
  }
  return {
    mode: "TE",
    gather,
    data: packRadarGram(gather, samples, nrec, nsrc),
    numTraces: nsrc,
    numSamples: samples,
    tout,
    srcx,
    srcz,
    recx,
    recz,
    dtS: grid.dt * grid.outstep,
    dtNs: grid.dt * grid.outstep * 1e9,
    dxM: Math.abs((pairs.src[1]?.[0] ?? pairs.src[0]?.[0] ?? 0) - (pairs.src[0]?.[0] ?? 0)) || grid.dx,
    x: Float32Array.from(pairs.src.map(p => p[0])),
    z: Float32Array.from(grid.z),
    work,
    meta: {
      fdtdMode: "TE",
      x: Float32Array.from(pairs.src.map(p => p[0])),
      timeAxisNs: Float32Array.from(tout, v => v * 1e9),
      sampleRateHz: 1 / (grid.dt * grid.outstep)
    }
  };
}

function updateTeMagnetic(Ex, Ez, Hy, grid, damping) {
  const { nx, nz, dx, dz, dt, mu } = grid;
  for (let ix = 0; ix < nx - 1; ix++) {
    for (let iz = 0; iz < nz - 1; iz++) {
      const i = ix * nz + iz;
      const m = Math.max(mu[i] * MU0, 1e-20);
      const curl = (Ez[i + nz] - Ez[i]) / dx - (Ex[i + 1] - Ex[i]) / dz;
      Hy[i] += dt / m * curl;
      Hy[i] *= damping[i];
    }
  }
}

function updateTeElectric(Ex, Ez, Hy, grid, damping) {
  const { nx, nz, dx, dz, dt, ep, sig } = grid;
  for (let ix = 1; ix < nx - 1; ix++) {
    for (let iz = 1; iz < nz - 1; iz++) {
      const i = ix * nz + iz;
      const eps = Math.max(ep[i] * EPS0, 1e-20);
      const sigma = Math.max(sig[i] || 0, 0);
      const lossA = (1 - sigma * dt / (2 * eps)) / (1 + sigma * dt / (2 * eps));
      const lossB = dt / eps / (1 + sigma * dt / (2 * eps));
      Ex[i] = (lossA * Ex[i] + lossB * (Hy[i] - Hy[i - 1]) / dz) * damping[i];
      Ez[i] = (lossA * Ez[i] - lossB * (Hy[i] - Hy[i - nz]) / dx) * damping[i];
    }
  }
}
