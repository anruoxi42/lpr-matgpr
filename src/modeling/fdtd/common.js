export const C0 = 299792458;
export const EPS0 = 8.8541878176e-12;
export const MU0 = 1.2566370614e-6;

export function createRickerPulse(frequencyHz = 500e6, dt = 0.3125e-9, samples = 640) {
  const out = new Float32Array(samples);
  const t0 = 1.5 / frequencyHz;
  for (let i = 0; i < samples; i++) {
    const a = Math.PI * frequencyHz * (i * dt - t0);
    out[i] = (1 - 2 * a * a) * Math.exp(-a * a);
  }
  return out;
}

export function normalizeFdtdInput(input = {}, options = {}) {
  const nx = input.nx || input.x?.length || 0;
  const nz = input.nz || input.z?.length || 0;
  if (nx < 5 || nz < 5) throw new Error("FDTD grid must be at least 5 x 5.");
  const x = Float64Array.from(input.x || buildAxis(nx, options.dxM || 0.02));
  const z = Float64Array.from(input.z || buildAxis(nz, options.dzM || options.dxM || 0.02));
  const ep = Float64Array.from(input.ep || input.epsr || input.epsrField || []);
  const mu = Float64Array.from(input.mu || input.muField || []);
  const sig = Float64Array.from(input.sig || input.sigma || input.sigmaField || []);
  if (ep.length !== nx * nz) throw new Error("FDTD ep grid size is invalid.");
  if (mu.length && mu.length !== nx * nz) throw new Error("FDTD mu grid size is invalid.");
  if (sig.length && sig.length !== nx * nz) throw new Error("FDTD sig grid size is invalid.");
  const muGrid = mu.length ? mu : filled(nx * nz, 1);
  const sigGrid = sig.length ? sig : new Float64Array(nx * nz);
  const dx = Math.abs(x[1] - x[0]) || Number(options.dxM) || 0.02;
  const dz = Math.abs(z[1] - z[0]) || Number(options.dzM) || dx;
  const dt = Number(options.dtS ?? options.dt ?? stableDt(ep, muGrid, dx, dz));
  const samples = Math.max(2, Math.floor(Number(options.samples || options.numSamples || input.srcpulse?.length || 640)));
  const srcpulse = Float64Array.from(input.srcpulse || createRickerPulse(options.frequencyHz || 500e6, dt, samples));
  const t = input.t ? Float64Array.from(input.t) : buildAxis(srcpulse.length, dt);
  const outstep = Math.max(1, Math.round(Number(options.outstep || 1)));
  const npml = Math.max(0, Math.round(Number(options.npml ?? 10)));
  return {
    nx,
    nz,
    x,
    z,
    ep,
    mu: muGrid,
    sig: sigGrid,
    dx,
    dz,
    dt,
    srcpulse,
    t,
    outstep,
    npml,
    defaultAntennaZ: input.defaultAntennaZ,
    defaultStartX: input.defaultStartX,
    defaultEndX: input.defaultEndX
  };
}

export function sourceReceiverPairs(grid, options = {}) {
  const defaultZ = Number(options.antennaZ ?? grid.defaultAntennaZ ?? grid.z[Math.max(1, Math.min(grid.z.length - 2, Math.round(grid.npml + 1)))]);
  if (options.srcloc?.length && options.recloc?.length) {
    const src = options.srcloc.map(p => [Number(p[0] ?? p.x ?? 0), Number(p[1] ?? p.z ?? defaultZ)]);
    const rec = options.recloc.map(p => [Number(p[0] ?? p.x ?? 0), Number(p[1] ?? p.z ?? defaultZ)]);
    validatePairs(grid, src, rec);
    return { src, rec };
  }
  const offset = Number(options.receiverOffsetM ?? options.receiverOffset ?? 0.317);
  const start = Number(options.startX ?? grid.defaultStartX ?? grid.x[Math.max(0, grid.npml + 2)] ?? grid.x[0]);
  const end = Number(options.endX ?? grid.defaultEndX ?? (grid.x[Math.min(grid.x.length - 1, grid.x.length - grid.npml - 3)] ?? grid.x[grid.x.length - 1]) - offset);
  const count = Math.max(1, Math.floor(Number(options.traceCount || options.numTraces || Math.min(80, grid.nx - 2 * grid.npml - 4))));
  const src = [];
  const rec = [];
  for (let i = 0; i < count; i++) {
    const f = count === 1 ? 0.5 : i / (count - 1);
    const x = start + (end - start) * f;
    src.push([x, defaultZ]);
    rec.push([x + offset, defaultZ]);
  }
  validatePairs(grid, src, rec);
  return { src, rec };
}

export function nearestIndex(axis, value) {
  let best = 0, dist = Infinity;
  for (let i = 0; i < axis.length; i++) {
    const d = Math.abs(axis[i] - value);
    if (d < dist) {
      dist = d;
      best = i;
    }
  }
  return best;
}

export function buildPmlDamping(nx, nz, npml, strength = 3.2) {
  const damping = new Float64Array(nx * nz);
  damping.fill(1);
  if (!npml) return damping;
  for (let ix = 0; ix < nx; ix++) {
    const dx = edgeRatio(ix, nx, npml);
    for (let iz = 0; iz < nz; iz++) {
      const dz = edgeRatio(iz, nz, npml);
      const r = Math.max(dx, dz);
      damping[ix * nz + iz] = Math.exp(-strength * r * r);
    }
  }
  return damping;
}

export function packRadarGram(gather, samples, receivers, shots) {
  const data = new Float32Array(samples * shots);
  for (let shot = 0; shot < shots; shot++) {
    for (let s = 0; s < samples; s++) data[shot * samples + s] = gather[(shot * receivers + 0) * samples + s] ?? 0;
  }
  return data;
}

export function buildAxis(count, step, offset = 0) {
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) out[i] = offset + i * step;
  return out;
}

export function estimateWork(grid, pairs, iterations) {
  return {
    cells: grid.nx * grid.nz,
    shots: pairs.src.length,
    iterations,
    updates: grid.nx * grid.nz * pairs.src.length * iterations
  };
}

function stableDt(ep, mu, dx, dz) {
  let cmax = 0;
  for (let i = 0; i < ep.length; i++) cmax = Math.max(cmax, C0 / Math.sqrt(Math.max(ep[i] * (mu[i] || 1), 1e-9)));
  return 0.45 / (cmax * Math.sqrt(1 / (dx * dx) + 1 / (dz * dz)));
}

function filled(n, value) {
  const out = new Float64Array(n);
  out.fill(value);
  return out;
}

function edgeRatio(i, n, npml) {
  const left = Math.max(0, npml - i) / npml;
  const right = Math.max(0, i - (n - npml - 1)) / npml;
  return Math.max(left, right);
}

function validatePairs(grid, src, rec) {
  const xmin = Math.min(grid.x[0], grid.x[grid.x.length - 1]);
  const xmax = Math.max(grid.x[0], grid.x[grid.x.length - 1]);
  const zmin = Math.min(grid.z[0], grid.z[grid.z.length - 1]);
  const zmax = Math.max(grid.z[0], grid.z[grid.z.length - 1]);
  for (const [label, list] of [["source", src], ["receiver", rec]]) {
    for (const p of list) {
      const x = Number(p[0]), z = Number(p[1]);
      if (!Number.isFinite(x) || !Number.isFinite(z) || x < xmin || x > xmax || z < zmin || z > zmax) {
        throw new Error(`FDTD ${label} location (${x}, ${z}) is outside the modeling grid.`);
      }
    }
  }
}
