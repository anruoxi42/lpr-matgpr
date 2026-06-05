import { buildAxis, depthMajorToXMajor, gridInterp, padGrid } from "./fdtd/grid.js";
import { MATERIAL_PRESETS, materialFromEpsr, normalizeMaterial } from "./materials.js";

export const DEFAULT_MODEL_MATERIALS = [
  { id: "layer0", name: "Layer 1", epsr: 9, sigma: 0.0005, mu: 1 },
  { id: "layer1", name: "Layer 2", epsr: 5.5, sigma: 0.0003, mu: 1 },
  { id: "layer2", name: "Layer 3", epsr: 4.5, sigma: 0.00025, mu: 1 },
  { id: "layer3", name: "Layer 4", epsr: 3.8, sigma: 0.0002, mu: 1 },
  { id: "layer4", name: "Layer 5", epsr: 3.2, sigma: 0.00015, mu: 1 }
];

export function createEmptyModel(options = {}) {
  const nx = Math.max(2, Math.floor(Number(options.numTraces || options.nx || 300)));
  const nz = Math.max(2, Math.floor(Number(options.depthSamples || options.nz || 240)));
  const dx = positive(options.distanceStepM ?? options.dxM, 0.05);
  const depthMax = positive(options.depthMaxM, 6);
  const dz = depthMax / Math.max(1, nz - 1);
  const background = normalizeMaterial(options.background || DEFAULT_MODEL_MATERIALS[0]);
  const epsrField = new Float32Array(nx * nz);
  const sigmaField = new Float32Array(nx * nz);
  const muField = new Float32Array(nx * nz);
  epsrField.fill(background.epsr);
  sigmaField.fill(background.sigma);
  muField.fill(background.mu);
  return {
    kind: "lpr-model2d",
    nx,
    nz,
    distanceAxisM: buildAxis(nx, dx),
    depthAxisM: buildAxis(nz, dz),
    distanceStepM: dx,
    depthStepM: dz,
    depthMaxM: depthMax,
    materials: [background],
    horizons: [],
    objects: [],
    epsrField,
    sigmaField,
    muField
  };
}

export function manualHorizonsToModel(horizons = [], options = {}) {
  const nx = Math.max(2, Math.floor(Number(options.numTraces || options.nx || horizons[0]?.line?.length || 300)));
  const nz = Math.max(2, Math.floor(Number(options.depthSamples || options.nz || options.modelSamples || 240)));
  const distanceStepM = positive(options.distanceStepM ?? options.dxM, 0.05);
  const depthMaxM = positive(options.depthMaxM || options.modelDepthMax, inferDepthMax(horizons, 6));
  const model = createEmptyModel({ nx, nz, distanceStepM, depthMaxM, background: DEFAULT_MODEL_MATERIALS[0] });
  const materials = normalizeLayerMaterials(options.layerMaterials, horizons.length + 1);
  model.materials = materials;
  model.horizons = horizons.map((h, i) => ({ ...h, index: i, line: Float32Array.from(h.line || []) }));
  for (let iz = 0; iz < nz; iz++) {
    const depth = model.depthAxisM[iz];
    for (let ix = 0; ix < nx; ix++) {
      const layerIndex = layerAt(model.horizons, ix, depth);
      const mat = materials[Math.min(layerIndex, materials.length - 1)];
      const idx = iz * nx + ix;
      model.epsrField[idx] = mat.epsr;
      model.sigmaField[idx] = mat.sigma;
      model.muField[idx] = mat.mu;
    }
  }
  if (options.objects?.length) {
    model.objects = options.objects.map(normalizeObject);
    applyObjectsToModel(model);
  }
  return model;
}

export function buildFixedModelFromDielectric(epsrField, options = {}) {
  const nx = Math.max(1, Number(options.nx || options.cols || 0));
  const nz = Math.max(1, Number(options.nz || options.rows || 0));
  if (!nx || !nz || !epsrField || epsrField.length !== nx * nz) throw new Error("buildFixedModelFromDielectric: invalid epsr grid.");
  const dx = positive(options.distanceStepM ?? options.IntDis, 0.02);
  const dz = positive(options.depthStepM ?? options.IntDis ?? dx, dx);
  const depthOffset = Number(options.depthOffsetM ?? options.zOffset ?? -positive(options.surfaceThicknessM, 0.6));
  const x = buildAxis(nx, dx);
  const z = buildAxis(nz, dz, depthOffset);
  const sigma = new Float32Array(nx * nz);
  const mu = new Float32Array(nx * nz);
  mu.fill(1);
  for (let i = 0; i < epsrField.length; i++) sigma[i] = materialFromEpsr(epsrField[i]).sigma;
  return {
    kind: "lpr-model2d",
    nx,
    nz,
    distanceAxisM: x,
    depthAxisM: z,
    distanceStepM: dx,
    depthStepM: dz,
    depthMaxM: z[z.length - 1],
    materials: DEFAULT_MODEL_MATERIALS,
    horizons: [],
    objects: [],
    epsrField: Float32Array.from(epsrField),
    sigmaField: sigma,
    muField: mu
  };
}

export function generateLayeredDielectric(options = {}) {
  const size = Math.max(32, Math.floor(Number(options.size || 1000)));
  const dielectric = new Float32Array(size * size);
  dielectric.fill(1);
  const b1 = generateBoundary(30, 300, 10, size, "linear", 15, 200, options.seed);
  const b2 = generateBoundary(330, 300, 10, size, "linear", 15, 200, addSeed(options.seed, 1));
  const b3 = generateBoundary(630, 300, 10, size, "exp", 15, 200, addSeed(options.seed, 2));
  const b4 = generateBoundary(800, 300, 10, size, "sin", 30, 800, addSeed(options.seed, 3));
  for (let x = 0; x < size; x++) {
    const y1 = clamp(Math.round(b1[x]), 0, size - 1);
    const y2 = clamp(Math.round(b2[x]), y1, size - 1);
    const y3 = clamp(Math.round(b3[x]), y2, size - 1);
    const y4 = clamp(Math.round(b4[x]), y3, size - 1);
    fillColumn(dielectric, size, x, y1, y2, 2);
    fillColumn(dielectric, size, x, y2 + 1, y3, 3);
    fillColumn(dielectric, size, x, y3 + 1, y4, 4);
    fillColumn(dielectric, size, x, y4 + 1, size - 1, 5);
  }
  const objects = [];
  if (options.randomRocks !== false) {
    const rng = mulberry32(Number(options.seed) || 12345);
    addRandomRocks(dielectric, size, b2, b3, b4, rng, objects);
  }
  return { ep: dielectric, nx: size, nz: size, boundaries: [b1, b2, b3, b4], objects };
}

export function applyObjectsToModel(model) {
  for (const object of model.objects || []) {
    const obj = normalizeObject(object);
    const mat = normalizeMaterial(obj, MATERIAL_PRESETS.find(m => m.id === obj.materialId) || MATERIAL_PRESETS[1]);
    for (let iz = 0; iz < model.nz; iz++) {
      const depth = model.depthAxisM[iz];
      for (let ix = 0; ix < model.nx; ix++) {
        const distance = model.distanceAxisM[ix];
        if (!pointInObject(distance, depth, obj)) continue;
        const idx = iz * model.nx + ix;
        model.epsrField[idx] = mat.epsr;
        model.sigmaField[idx] = mat.sigma;
        model.muField[idx] = mat.mu;
      }
    }
  }
  return model;
}

export function modelToFdtdGrid(model) {
  return {
    nx: model.nx,
    nz: model.nz,
    x: model.distanceAxisM,
    z: model.depthAxisM,
    ep: depthMajorToXMajor(model.epsrField, model.nx, model.nz),
    sig: depthMajorToXMajor(model.sigmaField, model.nx, model.nz),
    mu: depthMajorToXMajor(model.muField, model.nx, model.nz)
  };
}

export function prepareFdtdGridFromModel(model, options = {}) {
  const npml = Math.max(2, Math.round(Number(options.npml ?? model.npml ?? 10)));
  const receiverOffsetM = finiteNumber(options.receiverOffsetM ?? options.receiverOffset, 0.317);
  const baseDx = positive(options.baseDxM ?? model.distanceStepM ?? model.dxM, 0.02);
  const baseDz = positive(model.depthStepM ?? model.dzM ?? baseDx, baseDx);
  const airThicknessM = Math.max(0, Number(options.airThicknessM ?? model.airThicknessM ?? 0.6));
  const antennaZ = finiteNumber(options.antennaZ ?? model.antennaZ, airThicknessM > 0 ? -Math.min(0.3, airThicknessM / 2) : model.depthAxisM?.[0] ?? 0);
  const xBase = Float32Array.from(model.distanceAxisM || buildAxis(model.nx, baseDx));
  const withAir = addAirLayer(model, xBase, baseDz, airThicknessM);
  const epBase = depthMajorToXMajor(withAir.epsrField, model.nx, withAir.nz);
  const sigBase = depthMajorToXMajor(withAir.sigmaField, model.nx, withAir.nz);
  const muBase = depthMajorToXMajor(withAir.muField, model.nx, withAir.nz);

  const fdtdStep = positive(options.fdtdDxM ?? options.dxM ?? baseDx, baseDx);
  const propStep = fdtdStep / 2;
  const x2 = inclusiveAxis(xBase[0], xBase[xBase.length - 1], propStep);
  const z2 = inclusiveAxis(withAir.depthAxisM[0], withAir.depthAxisM[withAir.depthAxisM.length - 1], propStep);
  const ep2 = gridInterp(epBase, xBase, withAir.depthAxisM, x2, z2, "nearest");
  const sig2 = gridInterp(sigBase, xBase, withAir.depthAxisM, x2, z2, "nearest");
  const mu2 = gridInterp(muBase, xBase, withAir.depthAxisM, x2, z2, "nearest");
  const pad = 2 * npml + 1;
  const ep3 = makeOddPadded(padGrid(ep2, x2, z2, pad));
  const sig3 = makeOddPadded(padGrid(sig2, x2, z2, pad));
  const mu3 = makeOddPadded(padGrid(mu2, x2, z2, pad));

  const xMin = xBase[0];
  const xMax = xBase[xBase.length - 1];
  const defaultStartX = clamp(finiteNumber(options.startX, xMin + Math.min(50 * baseDx, Math.max(0, (xMax - xMin) * 0.05))), xMin, Math.max(xMin, xMax - receiverOffsetM));
  const defaultEndX = clamp(finiteNumber(options.endX, xMax - Math.min(50 * baseDx, Math.max(0, (xMax - xMin) * 0.05)) - receiverOffsetM), defaultStartX, Math.max(defaultStartX, xMax - receiverOffsetM));

  return {
    nx: ep3.nx,
    nz: ep3.nz,
    x: ep3.x,
    z: ep3.z,
    ep: ep3.data,
    sig: sig3.data,
    mu: mu3.data,
    npml,
    defaultAntennaZ: antennaZ,
    defaultStartX,
    defaultEndX,
    preparedFromModel2d: true,
    fdtdStepM: fdtdStep,
    propertyStepM: propStep,
    airThicknessM
  };
}

export function normalizeObject(object = {}) {
  const type = String(object.type || object.shape || "circle").toLowerCase();
  const material = normalizeMaterial(object, MATERIAL_PRESETS.find(m => m.id === object.materialId) || MATERIAL_PRESETS[1]);
  return {
    id: object.id || `obj-${Math.random().toString(36).slice(2, 9)}`,
    name: object.name || material.name || type,
    type,
    materialId: object.materialId || material.id || "custom",
    xM: Number(object.xM ?? object.centerX ?? object.leftDistance ?? object.x ?? 0),
    zM: Number(object.zM ?? object.centerDepth ?? object.topDepth ?? object.z ?? 0),
    widthM: positive(object.widthM ?? object.width, 0.5),
    heightM: positive(object.heightM ?? object.height, 0.4),
    radiusM: positive(object.radiusM ?? object.r ?? object.radius, 0.25),
    rotationDeg: Number(object.rotationDeg || 0),
    points: (object.points || []).map(p => ({ xM: Number(p.xM ?? p.x ?? 0), zM: Number(p.zM ?? p.y ?? 0) })),
    epsr: material.epsr,
    sigma: material.sigma,
    mu: material.mu
  };
}

export function objectBounds(object) {
  const o = normalizeObject(object);
  if (o.type === "circle" || o.type === "pipe") {
    return { left: o.xM - o.radiusM, right: o.xM + o.radiusM, top: o.zM - o.radiusM, bottom: o.zM + o.radiusM };
  }
  if (o.type === "polygon" && o.points.length) {
    return {
      left: Math.min(...o.points.map(p => p.xM)),
      right: Math.max(...o.points.map(p => p.xM)),
      top: Math.min(...o.points.map(p => p.zM)),
      bottom: Math.max(...o.points.map(p => p.zM))
    };
  }
  return { left: o.xM - o.widthM / 2, right: o.xM + o.widthM / 2, top: o.zM - o.heightM / 2, bottom: o.zM + o.heightM / 2 };
}

function pointInObject(x, z, object) {
  const o = object;
  if (o.type === "circle" || o.type === "pipe") return (x - o.xM) ** 2 + (z - o.zM) ** 2 <= o.radiusM ** 2;
  if (o.type === "ellipse") return ((x - o.xM) / (o.widthM / 2)) ** 2 + ((z - o.zM) / (o.heightM / 2)) ** 2 <= 1;
  if (o.type === "polygon" && o.points.length >= 3) return pointInPolygon(x, z, o.points);
  return Math.abs(x - o.xM) <= o.widthM / 2 && Math.abs(z - o.zM) <= o.heightM / 2;
}

function layerAt(horizons, traceIndex, depth) {
  let layer = 0;
  for (const h of horizons) {
    const hd = horizonDepthAtTrace(h, traceIndex);
    if (Number.isFinite(hd) && depth >= hd) layer++;
  }
  return layer;
}

function horizonDepthAtTrace(horizon, traceIndex) {
  const line = horizon.line || [];
  if (!line.length) return NaN;
  const i = Math.max(0, Math.min(line.length - 1, Math.round(traceIndex)));
  if (Number.isFinite(line[i])) return line[i];
  for (let r = 1; r < line.length; r++) {
    const l = i - r, rr = i + r;
    if (l >= 0 && Number.isFinite(line[l])) return line[l];
    if (rr < line.length && Number.isFinite(line[rr])) return line[rr];
  }
  return NaN;
}

function normalizeLayerMaterials(input, count) {
  const arr = input?.length ? input : DEFAULT_MODEL_MATERIALS;
  return Array.from({ length: count }, (_, i) => normalizeMaterial(arr[Math.min(i, arr.length - 1)] || DEFAULT_MODEL_MATERIALS[0]));
}

function inferDepthMax(horizons, fallback) {
  let max = 0;
  for (const h of horizons) for (const v of h.line || []) if (Number.isFinite(v)) max = Math.max(max, v);
  return max > 0 ? max * 1.25 : fallback;
}

function generateBoundary(base, thickness, amp, size, trendType, trendAmp, trendPeriod, seed = 1) {
  const rng = mulberry32(Number(seed) || 1);
  const noise = new Float64Array(size);
  for (let i = 0; i < size; i++) noise[i] = rng() * 2 - 1;
  const kernel = gaussianWindow(50);
  const smooth = convolveSame(noise, kernel);
  const out = new Float32Array(size);
  const lower = Math.max(1, base - thickness);
  const upper = Math.min(size, base + thickness);
  for (let i = 0; i < size; i++) {
    let trend = 0;
    if (trendType === "linear") trend = trendAmp * i / Math.max(1, size - 1);
    else if (trendType === "exp") trend = trendAmp * (Math.exp((i + 1) / (size / 2)) - 1);
    else if (trendType === "sin") trend = trendAmp * Math.sin(2 * Math.PI * (i + 1) / trendPeriod);
    out[i] = clamp(Math.round(base + amp * smooth[i] + trend), lower, upper);
  }
  return out;
}

function addRandomRocks(ep, size, layer2, layer3, layer4, rng, objects) {
  const count = 20 + Math.floor(rng() * 31);
  for (let i = 0; i < count; i++) {
    const x = Math.max(0, Math.min(size - 1, Math.floor(rng() * size)));
    let y;
    let epsr;
    if (rng() > 0.6) {
      y = randomInt(rng, layer4[x] + 1, size - 1);
      epsr = 5 + randomInt(rng, 1, 10) * 0.1;
    } else if (rng() > 0.4) {
      y = randomInt(rng, layer3[x] + 1, layer4[x]);
      epsr = 4 + randomInt(rng, 1, 10) * 0.1;
    } else {
      y = randomInt(rng, layer2[x] + 1, layer3[x]);
      epsr = 3 + randomInt(rng, 1, 10) * 0.1;
    }
    const radius = randomInt(rng, 5, 20);
    const vertices = randomPolygon(x, y, radius, rng);
    objects.push({ type: "polygon", points: vertices.map(p => ({ xM: p.x, zM: p.y })), epsr });
    for (let iz = Math.max(0, y - radius * 2); iz <= Math.min(size - 1, y + radius * 2); iz++) {
      for (let ix = Math.max(0, x - radius * 2); ix <= Math.min(size - 1, x + radius * 2); ix++) {
        if (pointInPolygon(ix, iz, vertices)) ep[iz * size + ix] = epsr;
      }
    }
  }
}

function randomPolygon(x0, y0, r, rng) {
  const n = randomInt(rng, 5, 8);
  const angles = Array.from({ length: n }, () => rng() * Math.PI * 2).sort((a, b) => a - b);
  return angles.map(a => {
    const rr = r * (0.8 + 0.4 * rng());
    return { x: x0 + Math.cos(a) * rr + r * 0.2 * (rng() * 2 - 1), z: y0 + Math.sin(a) * rr + r * 0.2 * (rng() * 2 - 1) };
  });
}

function pointInPolygon(x, z, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].xM ?? points[i].x;
    const zi = points[i].zM ?? points[i].z;
    const xj = points[j].xM ?? points[j].x;
    const zj = points[j].zM ?? points[j].z;
    if (((zi > z) !== (zj > z)) && x < (xj - xi) * (z - zi) / ((zj - zi) || 1e-12) + xi) inside = !inside;
  }
  return inside;
}

function fillColumn(data, size, x, y0, y1, value) {
  for (let y = Math.max(0, y0); y <= Math.min(size - 1, y1); y++) data[y * size + x] = value;
}

function addAirLayer(model, xAxis, dz, airThicknessM) {
  const firstDepth = Number(model.depthAxisM?.[0] ?? 0);
  if (firstDepth < 0 || airThicknessM <= 0) {
    return {
      nz: model.nz,
      depthAxisM: Float32Array.from(model.depthAxisM || buildAxis(model.nz, dz)),
      epsrField: model.epsrField,
      sigmaField: model.sigmaField,
      muField: model.muField
    };
  }
  const airRows = Math.max(1, Math.round(airThicknessM / dz));
  const nz = model.nz + airRows;
  const depthAxisM = new Float32Array(nz);
  for (let iz = 0; iz < nz; iz++) depthAxisM[iz] = (iz - airRows) * dz;
  const epsrField = new Float32Array(model.nx * nz);
  const sigmaField = new Float32Array(model.nx * nz);
  const muField = new Float32Array(model.nx * nz);
  epsrField.fill(1);
  sigmaField.fill(0);
  muField.fill(1);
  for (let iz = 0; iz < model.nz; iz++) {
    const src = iz * model.nx;
    const dst = (iz + airRows) * model.nx;
    epsrField.set(model.epsrField.subarray(src, src + model.nx), dst);
    sigmaField.set(model.sigmaField.subarray(src, src + model.nx), dst);
    muField.set(model.muField.subarray(src, src + model.nx), dst);
  }
  return { nz, depthAxisM, epsrField, sigmaField, muField };
}

function inclusiveAxis(start, end, step) {
  const count = Math.max(2, Math.floor((end - start) / step + 0.5) + 1);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = start + i * step;
  out[out.length - 1] = end;
  return out;
}

function makeOddPadded(padded) {
  let { data, x, z, nx, nz } = padded;
  if (nx % 2 === 1 && nz % 2 === 1) return padded;
  const nxOdd = nx % 2 === 1 ? nx : nx - 1;
  const nzOdd = nz % 2 === 1 ? nz : nz - 1;
  const out = new Float32Array(nxOdd * nzOdd);
  for (let ix = 0; ix < nxOdd; ix++) {
    for (let iz = 0; iz < nzOdd; iz++) out[ix * nzOdd + iz] = data[ix * nz + iz];
  }
  return { data: out, x: x.subarray(0, nxOdd), z: z.subarray(0, nzOdd), nx: nxOdd, nz: nzOdd };
}

function gaussianWindow(n) {
  const out = new Float64Array(n);
  const sigma = 0.4 * (n - 1) / 2;
  const center = (n - 1) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    out[i] = Math.exp(-0.5 * ((i - center) / sigma) ** 2);
    sum += out[i];
  }
  for (let i = 0; i < n; i++) out[i] /= sum || 1;
  return out;
}

function convolveSame(data, kernel) {
  const out = new Float64Array(data.length);
  const h = Math.floor(kernel.length / 2);
  for (let i = 0; i < data.length; i++) {
    let sum = 0;
    for (let k = 0; k < kernel.length; k++) {
      const j = Math.max(0, Math.min(data.length - 1, i + k - h));
      sum += data[j] * kernel[k];
    }
    out[i] = sum;
  }
  return out;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(rng, lo, hi) {
  const a = Math.ceil(Math.min(lo, hi));
  const b = Math.floor(Math.max(lo, hi));
  return a + Math.floor(rng() * Math.max(1, b - a + 1));
}

function addSeed(seed, delta) {
  return (Number(seed) || 1) + delta * 1013;
}

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
