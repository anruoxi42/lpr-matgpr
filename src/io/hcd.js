export const HCD_SOURCE_FORMAT = ".HCD";

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
  return {
    fields,
    dataBit,
    samples,
    traces,
    frequencyMHz,
    timeWindowNs,
    dxM: firstFinite(traceIncrementM, userDistanceIntervalM),
    traceIncrementM,
    userDistanceIntervalM,
    srDistanceM: numeric(fields["S/R DISTANC"]),
    soilVelocityRaw: numeric(fields["SOIL VELOCITY"]),
    antenna: fields.ANTENNA || "",
    antennaFreqMHz: numeric(fields.ANTENNA),
    mode: fields.MODE || ""
  };
}

function normalizeHcdParams(input = {}) {
  const params = typeof input === "string" ? parseHadText(input) : input;
  const fields = params.fields || params.hadFields || {};
  const dataBit = requirePositive(Number(params.dataBit ?? params.bit ?? params.bits ?? numeric(fields["DATA BIT"])), "DATA BIT");
  const samples = requirePositive(Number(params.samples ?? params.numSamples ?? numeric(fields.SAMPLES)), "SAMPLES");
  const traces = requirePositive(Number(params.traces ?? params.numTraces ?? numeric(fields["TRACE NUMBER"])), "TRACE NUMBER");
  const timeWindowNs = firstFinite(
    Number(params.timeWindowNs ?? params.timewindowNs ?? params.timeWindow ?? params.timewindow),
    numeric(fields.TIMEWINDOW)
  );
  const frequencyMHz = firstFinite(
    Number(params.frequencyMHz ?? params.frequency ?? params.sampleFrequencyMHz),
    numeric(fields.FREQUENCY)
  );
  const dxM = firstFinite(
    Number(params.dxM ?? params.traceIncrementM ?? params.traceIncrement),
    numeric(fields["TRACE INCREMENT"]),
    Number(params.userDistanceIntervalM ?? params.userDistanceInterval),
    numeric(fields["USER DISTANCE INTERVAL"]),
    1
  );
  const dtNs = firstFinite(
    Number(params.dtNs ?? params.dt),
    Number.isFinite(timeWindowNs) && timeWindowNs > 0 ? timeWindowNs / samples : NaN,
    Number.isFinite(frequencyMHz) && frequencyMHz > 0 ? 1000 / frequencyMHz : NaN
  );
  const sampleRateHz = firstFinite(
    Number(params.sampleRateHz),
    Number.isFinite(frequencyMHz) && frequencyMHz > 0 ? frequencyMHz * 1e6 : NaN,
    Number.isFinite(dtNs) && dtNs > 0 ? 1 / (dtNs * 1e-9) : NaN
  );
  return {
    fields,
    dataBit,
    samples,
    traces,
    timeWindowNs,
    frequencyMHz,
    dxM,
    dtNs: requirePositive(dtNs, "dtNs"),
    sampleRateHz,
    littleEndian: params.littleEndian !== false,
    srDistanceM: firstFinite(Number(params.srDistanceM), numeric(fields["S/R DISTANC"])),
    soilVelocityRaw: firstFinite(Number(params.soilVelocityRaw), numeric(fields["SOIL VELOCITY"])),
    antenna: params.antenna || fields.ANTENNA || "",
    antennaFreqMHz: firstFinite(Number(params.antennaFreqMHz), numeric(params.antenna || fields.ANTENNA)),
    mode: params.mode || fields.MODE || ""
  };
}

export function parseHcdFile(arrayBuffer, hadOrParams = {}) {
  const params = normalizeHcdParams(hadOrParams);
  if (![16, 32].includes(params.dataBit)) throw new Error(`HCD DATA BIT must be 16 or 32, got ${params.dataBit}`);
  const bytesPerSample = params.dataBit / 8;
  const expectedBytes = params.traces * params.samples * bytesPerSample;
  if (arrayBuffer.byteLength !== expectedBytes) {
    throw new Error(`HCD size mismatch: expected ${expectedBytes} bytes from HAD, got ${arrayBuffer.byteLength}`);
  }
  const view = new DataView(arrayBuffer);
  const total = params.traces * params.samples;
  const data = new Float32Array(total);
  if (params.dataBit === 16) {
    for (let i = 0, off = 0; i < total; i++, off += 2) data[i] = view.getInt16(off, params.littleEndian);
  } else {
    for (let i = 0, off = 0; i < total; i++, off += 4) data[i] = view.getInt32(off, params.littleEndian);
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
    littleEndian: params.littleEndian
  };
  return { data, meta, numTraces: params.traces, numSamples: params.samples };
}
