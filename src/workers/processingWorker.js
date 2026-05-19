import * as A from "../processing/algorithms.js";

self.onmessage = ({ data }) => {
  const { id, op, dataset, params = {} } = data;
  try {
    const d = new Float32Array(dataset.data);
    const nt = dataset.numTraces, ns = dataset.numSamples;
    let r;
    if (op === "remove-dc") r = A.removeDC(d, nt, ns);
    else if (op === "trim-time") r = A.trimTime(d, nt, ns, params.start, params.end);
    else if (op === "signal-position") r = A.signalPosition(d, nt, ns, params.shift);
    else if (op === "bad-traces") r = A.removeBadTraces(d, nt, ns, params.ranges);
    else if (op === "dewow") r = A.freqFilter(d, nt, ns, "hp", (params.cutoff || 2) * 1e6, 0, params.sampleRate || 1e9);
    else if (op === "equalize") r = A.equalize(d, nt, ns);
    else if (op === "resample-time") r = A.resample(d, nt, ns, "time", params.samples);
    else if (op === "resample-scan" || op === "equal-spacing") r = A.resample(d, nt, ns, "scan", params.traces);
    else if (op === "global-bg") r = A.backgroundRemove(d, nt, ns);
    else if (op === "horizontal") r = A.slidingBackground(d, nt, ns, params.width, "remove");
    else if (op === "dipping") r = A.slidingBackground(d, nt, ns, params.width, "retain");
    else if (op === "agc") r = A.agc(d, nt, ns, params.window, false);
    else if (op === "gagc") r = A.agc(d, nt, ns, params.window, true);
    else if (op === "power-gain") r = A.powerGain(d, nt, ns, params.power);
    else if (op === "amplitude-gain") r = A.amplitudeGain(d, nt, ns);
    else if (op === "fir-frequency") r = A.freqFilter(d, nt, ns, params.type, params.lo * 1e6, params.hi * 1e6, params.sampleRate || 1e9);
    else if (op === "fir-wavenumber" || op === "fk-filter" || op === "kl-filter") r = A.slidingBackground(d, nt, ns, params.width || 9, op === "kl-filter" ? "retain" : "remove");
    else if (op === "stolt" || op === "gazdag" || op === "pspi" || op === "split-step") r = A.simpleMigration(d, nt, ns, params.velocity, params.dt, params.dx);
    else if (op === "time-depth") r = A.timeDepth(d, nt, ns, params.velocity, params.dt, params.dz);
    else if (op === "instantaneous") r = A.instantaneous(d, nt, ns, params.attr);
    else if (op === "centroid") r = A.centroidFrequency(d, nt, ns);
    else if (op === "geology-model") r = A.geologicModel(d, nt, ns, params);
    else throw new Error("该功能已建立入口，算法将在下一阶段补全。");
    const transfers = r.data?.buffer ? [r.data.buffer] : [];
    if (r.modelData?.buffer) transfers.push(r.modelData.buffer);
    self.postMessage({ id, ok: true, result: r }, transfers);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error.message || String(error) });
  }
};
