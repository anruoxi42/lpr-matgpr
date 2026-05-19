export const RECORD_SIZE = 8307;
export const SAMPLES_PER_TRACE = 2048;

export function parse2BFile(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const fileSize = arrayBuffer.byteLength;
  const numTraces = Math.floor(fileSize / RECORD_SIZE);
  const remainder = fileSize % RECORD_SIZE;
  if (numTraces < 1) throw new Error("文件太小，无法解析为 .2B");
  const data = new Float32Array(numTraces * SAMPLES_PER_TRACE);
  const meta = {
    antennaId: new Uint32Array(numTraces),
    timestamp: new Float64Array(numTraces),
    velocity: new Float32Array(numTraces),
    posX: new Float32Array(numTraces),
    posY: new Float32Array(numTraces),
    posZ: new Float32Array(numTraces),
    attX: new Float32Array(numTraces),
    attY: new Float32Array(numTraces),
    attZ: new Float32Array(numTraces),
    validLen: new Uint16Array(numTraces),
    quality: new Uint8Array(numTraces),
    sourceFormat: ".2B",
    remainder
  };
  for (let i = 0; i < numTraces; i++) {
    const ro = i * RECORD_SIZE;
    meta.antennaId[i] = view.getUint32(ro, true);
    meta.timestamp[i] = view.getUint32(ro + 4, false) + view.getUint16(ro + 8, false) / 1000;
    meta.velocity[i] = view.getFloat32(ro + 10, false);
    meta.posX[i] = view.getFloat32(ro + 14, false);
    meta.posY[i] = view.getFloat32(ro + 18, false);
    meta.posZ[i] = view.getFloat32(ro + 22, false);
    meta.attX[i] = view.getFloat32(ro + 26, false);
    meta.attY[i] = view.getFloat32(ro + 30, false);
    meta.attZ[i] = view.getFloat32(ro + 34, false);
    meta.validLen[i] = view.getUint16(ro + 107, false);
    meta.quality[i] = view.getUint8(ro + 8306);
    const dOff = ro + 114;
    for (let j = 0; j < SAMPLES_PER_TRACE; j++) data[i * SAMPLES_PER_TRACE + j] = view.getFloat32(dOff + j * 4, true);
  }
  return { data, meta, numTraces, numSamples: SAMPLES_PER_TRACE };
}

export function write2BFile(ds) {
  if (ds.numSamples !== SAMPLES_PER_TRACE) throw new Error(".2B 导出要求每道 2048 样点，请先重采样时间轴。");
  const buf = new ArrayBuffer(ds.numTraces * RECORD_SIZE);
  const v = new DataView(buf);
  for (let i = 0; i < ds.numTraces; i++) {
    const ro = i * RECORD_SIZE;
    const m = ds.meta || {};
    v.setUint32(ro, m.antennaId?.[i] || 0, true);
    const ts = m.timestamp?.[i] || 0;
    v.setUint32(ro + 4, Math.floor(ts), false);
    v.setUint16(ro + 8, Math.round((ts % 1) * 1000), false);
    v.setFloat32(ro + 10, m.velocity?.[i] || 0, false);
    v.setFloat32(ro + 14, m.posX?.[i] || 0, false);
    v.setFloat32(ro + 18, m.posY?.[i] || 0, false);
    v.setFloat32(ro + 22, m.posZ?.[i] || 0, false);
    v.setFloat32(ro + 26, m.attX?.[i] || 0, false);
    v.setFloat32(ro + 30, m.attY?.[i] || 0, false);
    v.setFloat32(ro + 34, m.attZ?.[i] || 0, false);
    v.setUint16(ro + 107, m.validLen?.[i] || ds.numSamples, false);
    v.setUint8(ro + 8306, m.quality?.[i] || 0);
    for (let j = 0; j < ds.numSamples; j++) v.setFloat32(ro + 114 + j * 4, ds.data[i * ds.numSamples + j], true);
  }
  return new Blob([buf], { type: "application/octet-stream" });
}

export function writeMgpJson(ipd) {
  const compact = {
    name: ipd.name,
    numTraces: ipd.current.numTraces,
    numSamples: ipd.current.numSamples,
    metaSummary: summarizeMeta(ipd.current.meta),
    history: ipd.history,
    data: Array.from(ipd.current.data)
  };
  return new Blob([JSON.stringify(compact)], { type: "application/json" });
}

export function summarizeMeta(meta = {}) {
  return {
    sourceFormat: meta.sourceFormat || ".2B",
    firstTimestamp: meta.timestamp?.[0] || 0,
    firstPosition: [meta.posX?.[0] || 0, meta.posY?.[0] || 0, meta.posZ?.[0] || 0],
    remainder: meta.remainder || 0
  };
}

export function writeSEGYLike(ds, kind = "segy") {
  const ns = ds.numSamples, nt = ds.numTraces;
  const text = `${kind.toUpperCase()} experimental export from LPR matGPR\ntraces=${nt}\nsamples=${ns}\n`;
  const header = new TextEncoder().encode(text.padEnd(kind === "segy" ? 3600 : 240, " "));
  const buf = new ArrayBuffer(header.byteLength + ds.data.byteLength);
  new Uint8Array(buf).set(header, 0);
  new Uint8Array(buf).set(new Uint8Array(ds.data.buffer, ds.data.byteOffset, ds.data.byteLength), header.byteLength);
  return new Blob([buf], { type: "application/octet-stream" });
}

export function writeSEGYFile(ds, dtUs = 0.001, dxM = 0.05) {
  const nt = ds.numTraces, ns = ds.numSamples;
  const textHdrSize = 3200, binHdrSize = 400, trcHdrSize = 240, trcDataSize = ns * 4;
  const buf = new ArrayBuffer(textHdrSize + binHdrSize + nt * (trcHdrSize + trcDataSize));
  const v = new DataView(buf);
  const lines = [
    "C 1 SEG-Y REV1 exported from LPR matGPR                         ",
    "C 2 Source: CE-3 Lunar Penetrating Radar                         ",
    "C 3 Data format: IEEE 32-bit float, format code 5                ",
    `C 4 Traces: ${String(nt).padEnd(56, " ")}`,
    `C 5 Samples/trace: ${String(ns).padEnd(48, " ")}`,
    `C 6 Sample interval (us): ${String(dtUs).padEnd(39, " ")}`,
    `C 7 Trace spacing (m): ${String(dxM).padEnd(42, " ")}`
  ];
  for (let i = lines.length; i < 40; i++) lines.push(`C ${String(i + 1).padEnd(75, " ")}`);
  lines[39] = "C 40 END                                                         ";
  const text = lines.join("").padEnd(textHdrSize, " ").slice(0, textHdrSize);
  for (let i = 0; i < textHdrSize; i++) v.setUint8(i, text.charCodeAt(i) & 0xff);

  let off = textHdrSize;
  v.setInt32(off, 0, false); off += 4;
  v.setInt32(off, 0, false); off += 4;
  v.setInt32(off, 1, false); off += 4;
  v.setInt16(off, 1, false); off += 2;
  v.setInt16(off, 0, false); off += 2;
  const dtField = Math.max(1, Math.round(dtUs));
  v.setInt16(off, dtField, false); off += 2;
  v.setInt16(off, dtField, false); off += 2;
  v.setInt16(off, ns, false); off += 2;
  v.setInt16(off, ns, false); off += 2;
  v.setInt16(off, 5, false); off += 2;
  v.setInt16(off, 1, false); off += 2;
  v.setInt16(off, 1, false); off += 2;
  while (off < textHdrSize + binHdrSize) v.setUint8(off++, 0);

  off = textHdrSize + binHdrSize;
  for (let t = 0; t < nt; t++) {
    const traceStart = off;
    v.setInt32(off, t + 1, false); off += 4;
    v.setInt32(off, t + 1, false); off += 4;
    v.setInt32(off, 1, false); off += 4;
    v.setInt32(off, t + 1, false); off += 4;
    v.setInt32(off, 0, false); off += 4;
    v.setInt32(off, 0, false); off += 4;
    v.setInt32(off, 1, false); off += 4;
    v.setInt16(off, 1, false); off += 2;
    while (off < traceStart + 114) v.setUint8(off++, 0);
    v.setInt16(off, ns, false); off += 2;
    v.setInt16(off, dtField, false); off += 2;
    while (off < traceStart + trcHdrSize) v.setUint8(off++, 0);
    for (let s = 0; s < ns; s++) {
      v.setFloat32(off, ds.data[t * ns + s], false);
      off += 4;
    }
  }
  return new Blob([buf], { type: "application/octet-stream" });
}

export function writeDZTFile(ds, dtNs = 0.625, dxM = 0.05, rangeNs = ds.numSamples * dtNs) {
  const nt = ds.numTraces, ns = ds.numSamples;
  const hdrSize = 1024, trcDataSize = ns * 4;
  const buf = new ArrayBuffer(hdrSize + nt * trcDataSize);
  const v = new DataView(buf);
  v.setUint16(0, 0x00ff, true);
  v.setUint16(2, hdrSize / 4, true);
  v.setUint16(4, ns, true);
  v.setUint16(6, 32, true);
  v.setUint16(8, 0, true);
  v.setFloat32(10, 1000 / Math.max(dtNs, 1e-9), true);
  v.setFloat32(14, dxM, true);
  v.setFloat32(26, rangeNs, true);
  v.setFloat32(68, rangeNs, true);
  v.setUint8(99, 1);
  const nameBytes = new TextEncoder().encode(ds.name || "LPR Export");
  for (let i = 0; i < Math.min(nameBytes.length, 256); i++) v.setUint8(128 + i, nameBytes[i]);
  let off = hdrSize;
  for (let t = 0; t < nt; t++) {
    for (let s = 0; s < ns; s++) {
      v.setFloat32(off, ds.data[t * ns + s], true);
      off += 4;
    }
  }
  return new Blob([buf], { type: "application/octet-stream" });
}
