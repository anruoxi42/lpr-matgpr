import * as A from "../processing/algorithms.js";

function axisParams(dataset, params = {}) {
  const meta = dataset.meta || {};
  const dtNs = Number(params.dtNs ?? params.dt ?? dataset.dtNs ?? meta.dtNs ?? 0.625);
  const dxM = Number(params.dxM ?? params.dx ?? dataset.dxM ?? meta.dxM ?? 0.05);
  return {
    dtNs: Number.isFinite(dtNs) && dtNs > 0 ? dtNs : 0.625,
    dxM: Number.isFinite(dxM) && dxM > 0 ? dxM : 0.05
  };
}

function buildAxis(count, step, offset = 0) {
  const axis = new Float32Array(count);
  for (let i = 0; i < count; i++) axis[i] = offset + i * step;
  return axis;
}

function withUpdatedMeta(result, dataset, params = {}) {
  const axes = axisParams(dataset, params);
  const meta = { ...(dataset.meta || {}) };
  const sampleStart = result.sampleStart || 0;
  const dtNs = result.dtNs || axes.dtNs;
  const dxM = result.dxM || axes.dxM;
  meta.dtNs = dtNs;
  meta.dxM = dxM;
  meta.sampleRateHz = 1 / (dtNs * 1e-9);
  if (result.verticalAxisKind === "depth" || result.depthAxisM || result.depthStep) {
    meta.verticalAxisKind = "depth";
    meta.depthStep = result.depthStep;
    meta.depthAxisM = result.depthAxisM || buildAxis(result.numSamples, result.depthStep || 1);
  } else {
    meta.verticalAxisKind = "time";
    meta.timeAxisNs = buildAxis(result.numSamples, dtNs, sampleStart * axes.dtNs);
    meta.tt2w = meta.timeAxisNs;
  }
  meta.distanceAxisM = buildAxis(result.numTraces, dxM);
  meta.x = meta.distanceAxisM;
  if (result.vofh || params.vofh) meta.vofh = result.vofh || params.vofh;
  if (result.badTraces) meta.badTraces = result.badTraces;
  return { ...result, meta, dtNs, dxM };
}

self.onmessage = ({ data }) => {
  const { id, op, dataset, params = {} } = data;
  try {
    const d = new Float32Array(dataset.data);
    const nt = dataset.numTraces, ns = dataset.numSamples;
    const axes = axisParams(dataset, params);
    let r;
    if (op === "remove-dc") r = A.removeDC(d, nt, ns);
    else if (op === "trim-time") r = A.trimTime(d, nt, ns, params.start, params.end);
    else if (op === "signal-position") r = A.signalPosition(d, nt, ns, params.shift);
    else if (op === "bad-traces") r = A.removeBadTraces(d, nt, ns, params.ranges, { x: dataset.meta?.x || dataset.meta?.distanceAxisM });
    else if (op === "dewow") r = A.dewow(d, nt, ns);
    else if (op === "equalize") r = A.equalize(d, nt, ns);
    else if (op === "dzt-gain") {
      const gs = typeof params.gain === "string" ? params.gain : "";
      const gdb = gs ? gs.split(",").map(Number).filter(n => Number.isFinite(n)) : [];
      r = A.removeDztGain(d, nt, ns, { gainDb: gdb });
    }
    else if (op === "resample-time") r = A.resample(d, nt, ns, "time", params.samples, { ...params, dtNs: axes.dtNs });
    else if (op === "resample-scan" || op === "equal-spacing") r = A.resample(d, nt, ns, "scan", params.traces, { ...params, dxM: axes.dxM });
    else if (op === "global-bg") r = A.backgroundRemove(d, nt, ns);
    else if (op === "horizontal") r = A.slidingBackground(d, nt, ns, params.width, "remove");
    else if (op === "dipping") r = A.slidingBackground(d, nt, ns, params.width, "retain");
    else if (op === "agc") r = A.agc(d, nt, ns, { ...params, dtNs: axes.dtNs, windowNs: params.windowNs ?? params.window });
    else if (op === "gagc") r = A.gagc(d, nt, ns, { ...params, dtNs: axes.dtNs, windowNs: params.windowNs ?? params.window });
    else if (op === "power-gain") r = A.powerGain(d, nt, ns, { ...params, dtNs: axes.dtNs });
    else if (op === "amplitude-gain") r = A.amplitudeGain(d, nt, ns, { ...params, dtNs: axes.dtNs });
    else if (op === "fir-frequency") r = A.freqFilter(d, nt, ns, params.type, (params.lo ?? 20) * 1e6, (params.hi ?? 200) * 1e6, { dtNs: axes.dtNs });
    else if (op === "fir-wavenumber") r = A.kFilter(d, nt, ns, params.type, params.loK ?? params.lo ?? 0.2, params.hiK ?? params.hi ?? 5, axes.dxM);
    else if (op === "fk-filter") r = A.fkFilter(d, nt, ns, { ...params, dtNs: axes.dtNs, dxM: axes.dxM });
    else if (op === "kl-filter") r = A.karhunenLoeveFilter(d, nt, ns, params);
    else if (op === "fx-decon") r = A.fxDecon(d, nt, ns, { ...params, dtNs: axes.dtNs });
    else if (op === "sparse-decon") r = A.sparseDecon(d, nt, ns, { ...params, dtNs: axes.dtNs });
    else if (op === "attenuation-analysis") r = A.attenuationAnalysis(d, nt, ns, { ...params, dtNs: axes.dtNs });
    else if (op === "stolt") r = A.stoltMigration(d, nt, ns, { ...params, dtNs: axes.dtNs, dxM: axes.dxM });
    else if (op === "gazdag") r = A.gazdagMigration(d, nt, ns, { ...params, dtNs: axes.dtNs, dxM: axes.dxM });
    else if (op === "split-step") r = A.splitStepMigration(d, nt, ns, { ...params, dtNs: axes.dtNs, dxM: axes.dxM });
    else if (op === "pspi") r = A.pspiMigration(d, nt, ns, { ...params, dtNs: axes.dtNs, dxM: axes.dxM });
    else if (op === "time-depth") r = A.timeDepth(d, nt, ns, { ...params, dtNs: axes.dtNs });
    else if (op === "instantaneous") r = A.instantaneous(d, nt, ns, { ...params, dtNs: axes.dtNs });
    else if (op === "centroid") r = A.centroidFrequency(d, nt, ns);
    else if (op === "mean-median-filter") r = A.meanMedianFilter(d, nt, ns, params);
    else if (op === "notch-filter") r = A.notchFilter(d, nt, ns, { ...params, dtNs: axes.dtNs });
    else if (op === "predc") r = A.predictiveDecon(d, nt, ns, { ...params, dtNs: axes.dtNs });
    else if (op === "static-correction") r = A.staticCorrection(d, nt, ns, { ...params, dtNs: axes.dtNs });
    else if (op === "geo-energy-envelope") r = A.geologyEnergyEnvelope(d, nt, ns, params);
    else if (op === "geo-smooth-2d") r = A.geologySmooth2D(d, nt, ns, params);
    else if (op === "geo-trace-peaks") r = A.geologyTracePeaks(d, nt, ns, params);
    else if (op === "geo-depth-histogram") r = A.geologyDepthHistogram(d, nt, ns, params);
    else if (op === "geo-cluster-peaks") r = A.geologyClusterPeaks(d, nt, ns, params);
    else if (op === "geo-merge-clusters") r = A.geologyMergeClusters(d, nt, ns, params);
    else if (op === "geo-support-select") r = A.geologySelectSupported(d, nt, ns, params);
    else if (op === "geo-track-horizons") r = A.geologyTrackHorizons(d, nt, ns, params);
    else if (op === "geo-line-smooth") r = A.geologySmoothHorizonLines(d, nt, ns, params);
    else if (op === "geo-stratigraphy") r = A.geologyEnforceStratigraphy(d, nt, ns, params);
    else if (op === "geo-classify-model") r = A.geologyClassifyModel(d, nt, ns, params);
    else if (op === "geology-model") r = A.geologicModel(d, nt, ns, params);
    else throw new Error("Unknown op: " + op);
    r = withUpdatedMeta(r, dataset, params);
    const transfers = r.data?.buffer ? [r.data.buffer] : [];
    if (r.modelData?.buffer) transfers.push(r.modelData.buffer);
    self.postMessage({ id, ok: true, result: r }, transfers);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error.message || String(error) });
  }
};
