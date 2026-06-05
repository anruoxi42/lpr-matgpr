const MI_INT8 = 1;
const MI_UINT8 = 2;
const MI_INT16 = 3;
const MI_UINT16 = 4;
const MI_INT32 = 5;
const MI_UINT32 = 6;
const MI_SINGLE = 7;
const MI_DOUBLE = 9;
const MI_COMPRESSED = 15;
const MI_MATRIX = 14;

const MX_CHAR = 4;
const MX_DOUBLE = 6;

const KNOWN_TYPES = new Set([MI_INT8, MI_UINT8, MI_INT16, MI_UINT16, MI_INT32, MI_UINT32, MI_SINGLE, MI_DOUBLE, MI_COMPRESSED, MI_MATRIX]);

export function parseMatFile(arrayBuffer) {
  const bytes = normalizeBytes(arrayBuffer);
  assertSupportedHeader(bytes);
  return parseElements(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 128, null);
}

export async function parseMatFileAsync(arrayBuffer) {
  const bytes = normalizeBytes(arrayBuffer);
  assertSupportedHeader(bytes);
  return parseElementsAsync(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 128, null);
}

function assertSupportedHeader(bytes) {
  if (bytes.byteLength < 128) throw new Error("MAT file too small");
  const header = decodeAscii(bytes.subarray(0, Math.min(116, bytes.byteLength)));
  if (header.includes("MATLAB 7.3 MAT-file") || header.includes("HDF5")) {
    throw new Error("MATLAB 7.3/HDF5 MAT files are not supported by the static MAT v5 reader. Convert this file to MAT v5 or a JSON/binary fixture first.");
  }
}

function parseElements(dv, start, end) {
  const variables = {};
  let off = start;
  const limit = end ?? dv.byteLength;
  while (off + 8 <= limit) {
    const tag = readTag(dv, off);
    if (!tag || tag.bytes < 0 || tag.next > dv.byteLength + 8) break;
    if (tag.type === MI_MATRIX) {
      const { name, array } = parseMatrix(dv, tag.dataOffset, tag.bytes);
      if (name) variables[name] = array;
    } else if (tag.type === MI_COMPRESSED) {
      throw new Error("Compressed MAT v5 elements require parseMatFileAsync().");
    }
    off = tag.next;
  }
  return variables;
}

async function parseElementsAsync(dv, start, end) {
  const variables = {};
  let off = start;
  const limit = end ?? dv.byteLength;
  while (off + 8 <= limit) {
    const tag = readTag(dv, off);
    if (!tag || tag.bytes < 0 || tag.next > dv.byteLength + 8) break;
    if (tag.type === MI_MATRIX) {
      const { name, array } = parseMatrix(dv, tag.dataOffset, tag.bytes);
      if (name) variables[name] = array;
    } else if (tag.type === MI_COMPRESSED) {
      const inflated = await inflateBytes(new Uint8Array(dv.buffer, dv.byteOffset + tag.dataOffset, tag.bytes));
      Object.assign(variables, await parseElementsAsync(new DataView(inflated.buffer, inflated.byteOffset, inflated.byteLength), 0, null));
    }
    off = tag.next;
  }
  return variables;
}

function parseMatrix(dv, off, bytes) {
  const end = off + bytes;

  const flags = readTag(dv, off);
  off = flags.next;
  let mxClass = MX_DOUBLE;
  if (flags.type === MI_UINT32 || flags.type === MI_INT32) mxClass = dv.getUint32(flags.dataOffset, true) & 0xff;

  const dimsTag = readTag(dv, off);
  off = dimsTag.next;
  const dims = readInt32Values(dv, dimsTag);

  const nameTag = readTag(dv, off);
  off = nameTag.next;
  const name = readName(dv, nameTag);

  if (off >= end) return { name, array: null };
  const realTag = readTag(dv, off);
  const array = readNumericArray(dv, realTag, dims, mxClass);
  return { name, array };
}

function readTag(dv, off) {
  if (off + 4 > dv.byteLength) return null;
  const raw = dv.getUint32(off, true);
  const smallType = raw & 0xffff;
  const smallBytes = raw >>> 16;
  if (smallBytes > 0 && smallBytes <= 4 && KNOWN_TYPES.has(smallType)) {
    return { type: smallType, bytes: smallBytes, small: true, dataOffset: off + 4, next: off + 8 };
  }
  if (off + 8 > dv.byteLength) return null;
  const bytes = dv.getUint32(off + 4, true);
  const payloadOffset = off + 8;
  const next = payloadOffset + (raw === MI_COMPRESSED ? bytes : pad8(bytes));
  return { type: raw, bytes, small: false, dataOffset: payloadOffset, next };
}

function readInt32Values(dv, tag) {
  const dims = [];
  if (tag.type !== MI_INT32 && tag.type !== MI_UINT32) return dims;
  const count = Math.floor(tag.bytes / 4);
  for (let i = 0; i < count; i++) dims.push(dv.getInt32(tag.dataOffset + i * 4, true));
  return dims;
}

function readName(dv, tag) {
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset + tag.dataOffset, tag.bytes);
  return new TextDecoder().decode(bytes).replace(/\0/g, "").trim();
}

function readNumericArray(dv, tag, dims, mxClass) {
  if (!tag || tag.bytes === 0) return null;
  const nel = Math.max(1, dims.reduce((a, b) => a * b, 1) || 1);
  const rows = dims[0] || 1;
  const cols = dims[1] || 1;
  const off = tag.dataOffset;

  if (tag.type === MI_DOUBLE) {
    const out = new Float64Array(nel);
    for (let i = 0; i < nel; i++) out[i] = dv.getFloat64(off + i * 8, true);
    return wrap(out, rows, cols, "double", dims);
  }
  if (tag.type === MI_SINGLE) {
    const out = new Float32Array(nel);
    for (let i = 0; i < nel; i++) out[i] = dv.getFloat32(off + i * 4, true);
    return wrap(out, rows, cols, "single", dims);
  }
  if (tag.type === MI_INT32) {
    const out = new Int32Array(nel);
    for (let i = 0; i < nel; i++) out[i] = dv.getInt32(off + i * 4, true);
    return wrap(out, rows, cols, "int32", dims);
  }
  if (tag.type === MI_UINT32) {
    const out = new Uint32Array(nel);
    for (let i = 0; i < nel; i++) out[i] = dv.getUint32(off + i * 4, true);
    return wrap(out, rows, cols, "uint32", dims);
  }
  if (tag.type === MI_INT16) {
    const out = new Int16Array(nel);
    for (let i = 0; i < nel; i++) out[i] = dv.getInt16(off + i * 2, true);
    return wrap(out, rows, cols, "int16", dims);
  }
  if (tag.type === MI_UINT16 || mxClass === MX_CHAR) {
    const out = new Uint16Array(nel);
    for (let i = 0; i < nel; i++) out[i] = dv.getUint16(off + i * 2, true);
    if (mxClass === MX_CHAR) return String.fromCharCode(...out).replace(/\0/g, "").trim();
    return wrap(out, rows, cols, "uint16", dims);
  }
  if (tag.type === MI_UINT8) {
    return wrap(Uint8Array.from(new Uint8Array(dv.buffer, dv.byteOffset + off, nel)), rows, cols, "uint8", dims);
  }
  if (tag.type === MI_INT8) {
    return wrap(Int8Array.from(new Int8Array(dv.buffer, dv.byteOffset + off, nel)), rows, cols, "int8", dims);
  }
  const fallback = new Float32Array(nel);
  for (let i = 0; i < Math.min(nel, Math.floor(tag.bytes / 4)); i++) fallback[i] = dv.getFloat32(off + i * 4, true);
  return wrap(fallback, rows, cols, "single", dims);
}

async function inflateBytes(bytes) {
  if (typeof DecompressionStream !== "undefined") {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const zlib = await import("node:zlib");
  return Uint8Array.from(zlib.inflateSync(bytes));
}

function wrap(data, rows, cols, type, dims = [rows, cols]) {
  if (rows === 1 && cols === 1 && typeof data[0] === "number") return data[0];
  return { data, rows, cols, dims: Array.from(dims || [rows, cols]), type, length: data.length };
}

function normalizeBytes(arrayBuffer) {
  if (arrayBuffer instanceof Uint8Array) return arrayBuffer;
  return new Uint8Array(arrayBuffer);
}

function decodeAscii(bytes) {
  return Array.from(bytes, b => b >= 32 && b < 127 ? String.fromCharCode(b) : " ").join("");
}

function pad8(n) {
  return n + ((8 - (n % 8)) % 8);
}
