export const HCD_SOURCE_FORMAT = ".HCD";
export const HCD_DEFAULT_DT_NS = 0.3125;
export const HCD_DEFAULT_AMP = { min: -100, max: 100 };

function buildAxis(count, step, offset = 0) {
  const axis = new Float32Array(count);
  for (let i = 0; i < count; i++) axis[i] = offset + i * step;
  return axis;
}

function cleanKey(key) {
  return String(key || "").trim().replace(/\s+/g, " ").toUpperCase();
}

function numeric(value) {
  if (value == null) return NaN;
  const match = String(value).match(/[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/);
  return match ? Number(match[0]) : NaN;
}

function firstFinite(...values) {
  for (const value of values) if (Number.isFinite(value)) return value;
  return NaN;
}

function requirePositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`HCD ${label} is missing or invalid`);
  return value;
}

export function parseHadText(text = "") {
  const fields = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*([^:]+):\s*(.*?)\s*$/);
    if (!match) continue;
    fields[cleanKey(match[1])] = match[2].trim();
  }
  const dataBit = numeric(fields["DATA BIT"]);
  const samples = numeric(fields.SAMPLES);
  const traces = numeric(fields["TRACE NUMBER"]);
  const frequencyMHz = numeric(fields.FREQUENCY);
  const timeWindowNs = numeric(fields.TIMEWINDOW);
  const traceIncrementM = numeric(fields["TRACE INCREMENT"]);
  const userDistanceIntervalM = numeric(fields["USER DISTANCE INTERVAL"]);
  const srDistanceM = firstFinite(numeric(fields["S/R DISTANCE"]), numeric(fields["S/R DISTANC"]));
  return {
    fields,
    dataBit,
    samples,
    traces,
    frequencyMHz,
    timeWindowNs,
    dxM: firstFinite(traceIncrementM, userDistanceIntervalM, 1),
    traceIncrementM,
    userDistanceIntervalM,
    srDistanceM,
    soilVelocityRaw: numeric(fields["SOIL VELOCITY"]),
    antenna: fields.ANTENNA || "",
    antennaFreqMHz: numeric(fields.ANTENNA),
    mode: fields.MODE || ""
  };
}

function normalizeHad(had) {
  const params = typeof had === "string" ? parseHadText(had) : had;
  if (!params || !params.fields) throw new Error("HCD import requires a matching .had header file");
  const dataBit = requirePositive(Number(params.dataBit), "DATA BIT");
  const samples = requirePositive(Number(params.samples), "SAMPLES");
  const traces = requirePositive(Number(params.traces), "TRACE NUMBER");
  if (![16, 32].includes(dataBit)) throw new Error(`HCD DATA BIT must be 16 or 32, got ${dataBit}`);
  return {
    ...params,
    dataBit,
    samples,
    traces,
    dxM: firstFinite(Number(params.dxM), Number(params.traceIncrementM), Number(params.userDistanceIntervalM), 1),
    dtNs: HCD_DEFAULT_DT_NS,
    sampleRateHz: 1 / (HCD_DEFAULT_DT_NS * 1e-9)
  };
}

export function parseHcdFile(arrayBuffer, had) {
  const params = normalizeHad(had);
  const bytesPerSample = params.dataBit / 8;
  const expectedBytes = params.traces * params.samples * bytesPerSample;
  if (arrayBuffer.byteLength < expectedBytes) {
    throw new Error(`HCD size mismatch: expected at least ${expectedBytes} bytes from HAD, got ${arrayBuffer.byteLength}`);
  }
  const view = new DataView(arrayBuffer);
  const data = new Float32Array(params.traces * params.samples);
  for (let t = 0; t < params.traces; t++) {
    for (let s = 0; s < params.samples; s++) {
      const off = (t * params.samples + s) * bytesPerSample;
      data[t * params.samples + s] = params.dataBit === 16 ? view.getInt16(off, true) : view.getInt32(off, true);
    }
  }
  const timeAxisNs = buildAxis(params.samples, params.dtNs);
  const distanceAxisM = buildAxis(params.traces, params.dxM);
  const meta = {
    sourceFormat: HCD_SOURCE_FORMAT,
    dataBit: params.dataBit,
    had: { ...params.fields },
    dtNs: params.dtNs,
    dxM: params.dxM,
    sampleRateHz: params.sampleRateHz,
    frequencyMHz: params.frequencyMHz,
    timeWindowNs: params.timeWindowNs,
    timeAxisNs,
    tt2w: timeAxisNs,
    distanceAxisM,
    x: distanceAxisM,
    antenna: params.antenna,
    antennaFreqMHz: params.antennaFreqMHz,
    srDistanceM: params.srDistanceM,
    soilVelocityRaw: params.soilVelocityRaw,
    mode: params.mode,
    littleEndian: true,
    dataLayout: "MATLAB fread -> reshape(rawData, samples, traceNumber)",
    extraBytes: Math.max(0, arrayBuffer.byteLength - expectedBytes),
    displayAmpMin: HCD_DEFAULT_AMP.min,
    displayAmpMax: HCD_DEFAULT_AMP.max
  };
  return { data, meta, numTraces: params.traces, numSamples: params.samples };
}
