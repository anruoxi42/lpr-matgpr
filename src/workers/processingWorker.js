import * as A from "../processing/algorithms.js";
import { buildFixedModelFromDielectric, generateLayeredDielectric, manualHorizonsToModel, prepareFdtdGridFromModel } from "../modeling/model2d.js";
import { simulateTm2d } from "../modeling/fdtd/tm2d.js";
import { simulateTe2d } from "../modeling/fdtd/te2d.js";

function axisParams(dataset, params = {}) {
  const meta = dataset.meta || {};
  const rp = meta.radarParams || {};
  const dtNs = Number(params.dtNs ?? params.dt ?? dataset.dtNs ?? rp.dtNs ?? meta.dtNs ?? 0.625);
  const dxM = Number(params.dxM ?? params.dx ?? dataset.dxM ?? rp.dxM ?? meta.dxM ?? 0.05);
  return {
    dtNs: Number.isFinite(dtNs) && dtNs > 0 ? dtNs : 0.625,
    dxM: Number.isFinite(dxM) && dxM > 0 ? dxM : 0.05,
    velocityMPerNs: Number(params.velocity ?? params.velocityMPerNs ?? rp.velocityMPerNs ?? 0.1),
    vofhText: String(params.vofh ?? params.vofhText ?? rp.vofhText ?? "0.1,0")
  };
}

function buildAxis(count, step, offset = 0) {
  const axis = new Float32Array(count);
  for (let i = 0; i < count; i++) axis[i] = offset + i * step;
  return axis;
}

function withUpdatedMeta(result, dataset, params = {}) {
  const axes = axisParams(dataset, params);
  const meta = { ...(dataset.meta || {}), ...(result.meta || {}) };
  const sampleStart = result.sampleStart || 0;
  const dtNs = result.dtNs || axes.dtNs;
  const dxM = result.dxM || axes.dxM;
  meta.dtNs = dtNs;
  meta.dxM = dxM;
  meta.radarParams = {
    ...(meta.radarParams || {}),
    dtNs,
    dxM,
    velocityMPerNs: Number.isFinite(axes.velocityMPerNs) && axes.velocityMPerNs > 0 ? axes.velocityMPerNs : 0.1,
    vofhText: axes.vofhText
  };
  meta.sampleRateHz = 1 / (dtNs * 1e-9);
  if (result.verticalAxisKind === "depth" || result.depthAxisM || result.depthStep) {
    meta.verticalAxisKind = "depth";
    meta.depthStep = result.depthStep;
    meta.depthAxisM = result.depthAxisM || buildAxis(result.numSamples, result.depthStep || 1);
  } else {
    meta.verticalAxisKind = "time";
    meta.timeAxisNs = result.meta?.timeAxisNs || result.timeAxisNs || buildAxis(result.numSamples, dtNs, sampleStart * axes.dtNs);
    meta.tt2w = meta.timeAxisNs;
  }
  meta.distanceAxisM = result.distanceAxisM || result.x || result.srcx || meta.distanceAxisM || buildAxis(result.numTraces, dxM);
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
    else if (op === "model2d-build") {
      const model = manualHorizonsToModel(params.horizons || [], {
        numTraces: params.numTraces || nt,
        depthSamples: params.depthSamples || params.modelSamples || 240,
        distanceStepM: params.distanceStepM || axes.dxM,
        depthMaxM: params.depthMaxM || params.modelDepthMax,
        layerMaterials: params.layerMaterials,
        objects: params.objects
      });
      r = {
        data: model.epsrField,
        numTraces: model.nx,
        numSamples: model.nz,
        verticalAxisKind: "depth",
        depthAxisM: model.depthAxisM,
        depthStep: model.depthStepM,
        dxM: model.distanceStepM,
        model2d: model,
        name: "model2d_epsr"
      };
    }
    else if (op === "p5-random-model") {
      const layered = generateLayeredDielectric(params);
      const intDis = Number(params.IntDis ?? params.distanceStepM ?? params.dxM ?? 0.02);
      r = {
        data: layered.ep,
        ep: layered.ep,
        numTraces: layered.nx,
        numSamples: layered.nz,
        verticalAxisKind: "depth",
        depthAxisM: buildAxis(layered.nz, intDis),
        depthStep: intDis,
        dxM: intDis,
        distanceAxisM: buildAxis(layered.nx, intDis),
        boundaries: layered.boundaries,
        boundaryOptions: layered.boundaryOptions,
        layerValues: layered.layerValues,
        objects: layered.objects,
        name: "p5_1_dielectric"
      };
    }
    else if (op === "p5-conductivity-model") {
      const nxModel = Math.max(1, Math.floor(Number(params.nx || params.cols || params.numTraces || 0)));
      const nzModel = Math.max(1, Math.floor(Number(params.nz || params.rows || params.numSamples || 0)));
      const ep = params.ep || params.data || [];
      if (!ep?.length || ep.length !== nxModel * nzModel) throw new Error("p5 conductivity conversion requires an ep grid.");
      const intDis = Number(params.IntDis ?? params.distanceStepM ?? params.dxM ?? 0.02);
      const airRows = Math.max(0, Math.floor(Number(params.airRows ?? params.lTHK ?? 30)));
      const model = buildFixedModelFromDielectric(Float32Array.from(ep), {
        nx: nxModel,
        nz: nzModel,
        IntDis: intDis,
        depthOffsetM: -airRows * intDis,
        frequencyHz: params.frequencyHz ?? params.startFrequencyHz ?? 500e6,
        conductivityDtNs: params.conductivityDtNs ?? params.dtNsForConductivity ?? 0.3125
      });
      r = {
        data: model.epsrField,
        numTraces: model.nx,
        numSamples: model.nz,
        verticalAxisKind: "depth",
        depthAxisM: model.depthAxisM,
        depthStep: model.depthStepM,
        dxM: model.distanceStepM,
        model2d: model,
        name: "p5_2_Model"
      };
    }
    else if (op === "split-step-forward2d") {
      const model = params.model2d || params.model;
      if (!model) throw new Error("Split-step forward requires a model2d payload.");
      const progress = detail => self.postMessage({ id, progress: true, detail });
      r = A.splitStepForward2d(model, { ...(params.forward || params), onProgress: progress });
      r.model2d = model;
      r.name = "split_step_forward2d";
    }
    else if (op === "fdtd-tm2d" || op === "fdtd-te2d") {
      const model = params.model2d || params.model;
      if (!model) throw new Error("FDTD requires a model2d payload.");
      const fdtdParams = params.fdtd || params;
      const grid = prepareFdtdGridFromModel(model, fdtdParams);
      const progress = detail => self.postMessage({ id, progress: true, detail });
      r = op === "fdtd-te2d"
        ? simulateTe2d(grid, { ...fdtdParams, onProgress: progress })
        : simulateTm2d(grid, { ...fdtdParams, onProgress: progress });
      r.model2d = model;
      r.fdtdGrid = { nx: grid.nx, nz: grid.nz, x: grid.x, z: grid.z, npml: grid.npml, airThicknessM: grid.airThicknessM, defaultAntennaZ: grid.defaultAntennaZ };
      r.name = op === "fdtd-te2d" ? "fdtd_te2d_forward" : "fdtd_tm2d_forward";
    }
    else throw new Error("Unknown op: " + op);
    r = withUpdatedMeta(r, dataset, params);
    const transfers = r.data?.buffer ? [r.data.buffer] : [];
    if (r.modelData?.buffer) transfers.push(r.modelData.buffer);
    if (r.model2d?.epsrField?.buffer && !transfers.includes(r.model2d.epsrField.buffer)) transfers.push(r.model2d.epsrField.buffer);
    if (r.model2d?.sigmaField?.buffer && !transfers.includes(r.model2d.sigmaField.buffer)) transfers.push(r.model2d.sigmaField.buffer);
    if (r.model2d?.muField?.buffer && !transfers.includes(r.model2d.muField.buffer)) transfers.push(r.model2d.muField.buffer);
    if (r.gather?.buffer && !transfers.includes(r.gather.buffer)) transfers.push(r.gather.buffer);
    self.postMessage({ id, ok: true, result: r }, transfers);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error.message || String(error) });
  }
};
