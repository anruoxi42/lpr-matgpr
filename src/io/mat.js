const MI_INT8 = 1;
const MI_UINT8 = 2;
const MI_INT32 = 5;
const MI_UINT32 = 6;
const MI_SINGLE = 7;
const MI_DOUBLE = 9;
const MI_MATRIX = 14;
const MI_UINT16 = 4;

const MX_CHAR = 4;
const MX_DOUBLE = 6;
const MX_SINGLE = 7;
const MX_UINT8 = 9;

export function writeMatFile(variables = {}) {
  const chunks = [matHeader()];
  for (const [name, value] of Object.entries(variables)) chunks.push(matrixElement(name, normalizeVariable(value)));
  return concat(chunks).buffer;
}

export function variablesFromForwardResult(result = {}, model = null, params = {}) {
  const vars = {
    radar_gram: {
      data: traceMajorToMat(result.data || new Float32Array(), result.numTraces || 0, result.numSamples || 0),
      dims: [result.numSamples || 0, result.numTraces || 0],
      type: "single"
    },
    t: { data: Float64Array.from(result.tout || [], v => Number(v)), dims: [result.tout?.length || result.numSamples || 0, 1], type: "double" },
    src_values: { data: Float32Array.from(result.srcx || result.x || []), dims: [1, result.srcx?.length || result.x?.length || 0], type: "single" },
    params: JSON.stringify(params || {})
  };
  if (model) {
    vars.ep = { data: depthMajorToMat(model.epsrField || new Float32Array(), model.nx || 0, model.nz || 0), dims: [model.nz || 0, model.nx || 0], type: "single" };
    vars.mu = { data: depthMajorToMat(model.muField || new Float32Array(), model.nx || 0, model.nz || 0), dims: [model.nz || 0, model.nx || 0], type: "single" };
    vars.sig = { data: depthMajorToMat(model.sigmaField || new Float32Array(), model.nx || 0, model.nz || 0), dims: [model.nz || 0, model.nx || 0], type: "single" };
    vars.cd = { data: depthMajorToMat(model.sigmaField || new Float32Array(), model.nx || 0, model.nz || 0), dims: [model.nz || 0, model.nx || 0], type: "single" };
    vars.x = { data: Float32Array.from(model.distanceAxisM || []), dims: [1, model.nx || 0], type: "single" };
    vars.z = { data: Float32Array.from(model.depthAxisM || []), dims: [model.nz || 0, 1], type: "single" };
  }
  return vars;
}

export function variablesFromModelGrid(model = {}, params = {}) {
  const nx = model.nx || model.numTraces || 0;
  const nz = model.nz || model.numSamples || 0;
  const dx = Number(params.IntDis ?? params.distanceStepM ?? params.dxM ?? model.distanceStepM ?? 0.02);
  const vars = {
    ep: { data: depthMajorToMat(model.epsrField || model.ep || model.data || new Float32Array(), nx, nz), dims: [nz, nx], type: "single" },
    mu: { data: depthMajorToMat(model.muField || filled(nx * nz, 1), nx, nz), dims: [nz, nx], type: "single" },
    sig: { data: depthMajorToMat(model.sigmaField || model.sig || model.cd || new Float32Array(nx * nz), nx, nz), dims: [nz, nx], type: "single" },
    cd: { data: depthMajorToMat(model.sigmaField || model.cd || model.sig || new Float32Array(nx * nz), nx, nz), dims: [nz, nx], type: "single" },
    x: { data: Float32Array.from(model.distanceAxisM || axis(nx, dx, 0)), dims: [1, nx], type: "single" },
    z: { data: Float32Array.from(model.depthAxisM || axis(nz, dx, Number(params.depthOffsetM ?? model.depthOffsetM ?? 0))), dims: [nz, 1], type: "single" },
    IntDis: { data: Float32Array.of(dx), dims: [1, 1], type: "single" },
    width: { data: Float32Array.of(nx), dims: [1, 1], type: "single" },
    rows: { data: Float32Array.of(nz), dims: [1, 1], type: "single" },
    cols: { data: Float32Array.of(nx), dims: [1, 1], type: "single" },
    params: JSON.stringify(params || {})
  };
  return vars;
}

export function variablesFromP5Dielectric(result = {}, params = {}) {
  const nx = result.nx || result.cols || 0;
  const nz = result.nz || result.rows || 0;
  const dx = Number(params.IntDis ?? params.distanceStepM ?? params.dxM ?? 0.02);
  return {
    ep: { data: depthMajorToMat(result.ep || result.data || new Float32Array(), nx, nz), dims: [nz, nx], type: "single" },
    IntDis: { data: Float32Array.of(dx), dims: [1, 1], type: "single" },
    width: { data: Float32Array.of(nx), dims: [1, 1], type: "single" },
    rows: { data: Float32Array.of(nz), dims: [1, 1], type: "single" },
    cols: { data: Float32Array.of(nx), dims: [1, 1], type: "single" },
    layer_values: { data: Float32Array.from(result.layerValues || params.layerValues || []), dims: [1, (result.layerValues || params.layerValues || []).length], type: "single" },
    params: JSON.stringify(params || {})
  };
}

export function variablesFromCurrentDataset(ds = {}) {
  const data = ds.data || new Float32Array();
  const nt = ds.numTraces || 0;
  const ns = ds.numSamples || 0;
  const meta = ds.meta || {};
  const rp = meta.radarParams || {};
  const vars = {
    radar_data: {
      data: traceMajorToMat(data, nt, ns),
      dims: [ns, nt],
      type: "single"
    },
    dt_ns: { data: Float32Array.of(rp.dtNs || 0.625), dims: [1, 1], type: "single" },
    dx_m: { data: Float32Array.of(rp.dxM || 0.05), dims: [1, 1], type: "single" },
    velocity_m_ns: { data: Float32Array.of(rp.velocityMPerNs || 0.1), dims: [1, 1], type: "single" },
    epsilon_r: { data: Float32Array.of(rp.epsilonR || 9), dims: [1, 1], type: "single" },
    antenna_freq_mhz: { data: Float32Array.of(rp.antennaFreqMHz || 60), dims: [1, 1], type: "single" },
    source_format: String(meta.sourceFormat || ".2B"),
    created_at: (new Date()).toISOString()
  };
  const x = meta.x || meta.distanceAxisM;
  if (x?.length) vars.distance_array_m = { data: Float32Array.from(x), dims: [1, x.length], type: "single" };
  const t = meta.tt2w || meta.timeAxisNs;
  if (t?.length) vars.time_array_ns = { data: Float32Array.from(t), dims: [t.length, 1], type: "single" };
  return vars;
}

function matHeader() {
  const out = new Uint8Array(128);
  const text = encodeAscii(`MATLAB 5.0 MAT-file, Platform: LPR-MATGPR, Created by JS exporter`);
  out.set(text.slice(0, 116), 0);
  const view = new DataView(out.buffer);
  view.setUint16(124, 0x0100, true);
  out[126] = 0x49;
  out[127] = 0x4d;
  return out;
}

function matrixElement(name, variable) {
  const flags = dataElement(MI_UINT32, uint32Bytes([variable.mxClass, 0]));
  const dims = dataElement(MI_INT32, int32Bytes(variable.dims));
  const varName = dataElement(MI_INT8, encodeAscii(name));
  const real = dataElement(variable.miType, numericBytes(variable));
  return dataElement(MI_MATRIX, concat([flags, dims, varName, real]));
}

function normalizeVariable(value) {
  if (typeof value === "string") {
    return { data: value, dims: [1, value.length], miType: MI_UINT16, mxClass: MX_CHAR, type: "char" };
  }
  const data = value?.data || value;
  const type = String(value?.type || inferType(data)).toLowerCase();
  const dims = value?.dims || [data?.length || 0, 1];
  if (type === "double" || data instanceof Float64Array) return { data: Float64Array.from(data || []), dims, miType: MI_DOUBLE, mxClass: MX_DOUBLE, type: "double" };
  if (type === "uint8" || data instanceof Uint8Array) return { data: Uint8Array.from(data || []), dims, miType: MI_UINT8, mxClass: MX_UINT8, type: "uint8" };
  return { data: Float32Array.from(data || []), dims, miType: MI_SINGLE, mxClass: MX_SINGLE, type: "single" };
}

function numericBytes(variable) {
  if (variable.type === "char") return uint16Bytes(Array.from(variable.data, ch => ch.charCodeAt(0)));
  if (variable.type === "double") {
    const out = new Uint8Array(variable.data.length * 8);
    const view = new DataView(out.buffer);
    for (let i = 0; i < variable.data.length; i++) view.setFloat64(i * 8, variable.data[i], true);
    return out;
  }
  if (variable.type === "uint8") return Uint8Array.from(variable.data);
  const out = new Uint8Array(variable.data.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < variable.data.length; i++) view.setFloat32(i * 4, variable.data[i], true);
  return out;
}

function dataElement(type, payload) {
  const bytes = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
  const pad = padding(bytes.length);
  const out = new Uint8Array(8 + bytes.length + pad);
  const view = new DataView(out.buffer);
  view.setUint32(0, type, true);
  view.setUint32(4, bytes.length, true);
  out.set(bytes, 8);
  return out;
}

function traceMajorToMat(data, traces, samples) {
  const out = new Float32Array(samples * traces);
  for (let t = 0; t < traces; t++) for (let s = 0; s < samples; s++) out[s + t * samples] = data[t * samples + s] || 0;
  return out;
}

function depthMajorToMat(data, nx, nz) {
  const out = new Float32Array(nx * nz);
  for (let ix = 0; ix < nx; ix++) for (let iz = 0; iz < nz; iz++) out[iz + ix * nz] = data[iz * nx + ix] || 0;
  return out;
}

function axis(count, step, offset = 0) {
  return Float32Array.from({ length: Math.max(0, count) }, (_, i) => offset + i * step);
}

function filled(count, value) {
  const out = new Float32Array(Math.max(0, count));
  out.fill(value);
  return out;
}

function uint32Bytes(values) {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setUint32(i * 4, v, true));
  return out;
}

function int32Bytes(values) {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setInt32(i * 4, v, true));
  return out;
}

function uint16Bytes(values) {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  values.forEach((v, i) => view.setUint16(i * 2, v, true));
  return out;
}

function encodeAscii(text) {
  return Uint8Array.from(String(text), ch => ch.charCodeAt(0) & 0xff);
}

function concat(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function padding(length) {
  return (8 - (length % 8)) % 8;
}

function inferType(data) {
  if (data instanceof Float64Array) return "double";
  if (data instanceof Uint8Array) return "uint8";
  return "single";
}
