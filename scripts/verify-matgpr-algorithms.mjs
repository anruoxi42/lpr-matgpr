import {
  agc,
  attenuationAnalysis,
  amplitudeGain,
  dewow,
  fxDecon,
  fkFilter,
  freqFilter,
  gagc,
  kFilter,
  karhunenLoeveFilter,
  powerGain,
  removeBadTraces,
  resample,
  sparseDecon,
  slidingBackground,
  spectrum,
  splitStepMigration,
  stoltMigration,
  gazdagMigration,
  geologicModel,
  timeDepth
} from "../src/processing/algorithms.js";
import { HCD_DEFAULT_DT_NS, parseHadText, parseHcdFile } from "../src/io/hcd.js";
import { localMaxima, pickPeaksNearPoint, traceFromSeed } from "../src/processing/peakTracking.js";
import { generateLayeredDielectric, manualHorizonsToModel, modelToFdtdGrid, prepareFdtdGridFromModel } from "../src/modeling/model2d.js";
import { calConductivity, calDensity, calLossTangent } from "../src/modeling/materials.js";
import { estimateGridSpacing, gridInterp, padGrid } from "../src/modeling/fdtd/grid.js";
import { simulateTm2d } from "../src/modeling/fdtd/tm2d.js";
import { simulateTe2d } from "../src/modeling/fdtd/te2d.js";
import { variablesFromForwardResult, writeMatFile } from "../src/io/mat.js";
import { parseMatFileAsync } from "../src/io/mat-reader.js";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const softwareRoot = dirname(root);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function finite(data, label) {
  for (const v of data) assert(Number.isFinite(v), `${label} contains non-finite values`);
}

function rms(data) {
  let s = 0;
  for (const v of data) s += v * v;
  return Math.sqrt(s / Math.max(1, data.length));
}

function lowBandEnergy(trace, bins = 4) {
  const sp = spectrum(trace);
  let e = 0;
  for (let i = 0; i < Math.min(bins, sp.length); i++) e += sp[i] * sp[i];
  return e;
}

function synthetic(nt = 64, ns = 128) {
  const data = new Float32Array(nt * ns);
  for (let t = 0; t < nt; t++) {
    for (let s = 0; s < ns; s++) {
      const drift = 0.7 * Math.sin(2 * Math.PI * s / ns);
      const event = Math.sin(2 * Math.PI * (s / 12 + t / 24));
      const dip = Math.sin(2 * Math.PI * ((s - t * 0.7) / 16));
      const decay = Math.exp(-s / 78);
      data[t * ns + s] = drift + decay * (event + 0.45 * dip);
    }
  }
  return data;
}

const nt = 64, ns = 128, dtNs = 0.625, dxM = 0.05;
const data = synthetic(nt, ns);

const beforeLow = lowBandEnergy(data.subarray(0, ns));
const dw = dewow(data, nt, ns);
finite(dw.data, "dewow");
assert(dw.numTraces === nt && dw.numSamples === ns, "dewow changed dimensions");
assert(lowBandEnergy(dw.data.subarray(0, ns)) < beforeLow * 0.85, "dewow did not suppress low-band drift");

const standard = agc(data, nt, ns, { dtNs, windowNs: 31.25 });
const gaussian = gagc(data, nt, ns, { dtNs, windowNs: 31.25, eps: 5e-7 });
finite(standard.data, "standard agc");
finite(gaussian.data, "gaussian agc");
assert(rms(standard.data) > 0 && rms(gaussian.data) > 0, "AGC output is empty");

const zeros = new Float32Array(nt * ns);
finite(agc(zeros, nt, ns, { dtNs, windowNs: 31.25 }).data, "zero agc");
assert(rms(gagc(zeros, nt, ns, { dtNs, windowNs: 31.25 }).data) === 0, "zero GAGC should remain zero");

const pGain = powerGain(data, nt, ns, { dtNs, power: "auto" });
const aGain = amplitudeGain(data, nt, ns, { dtNs, curve: "median", order: 2 });
finite(pGain.data, "power gain");
finite(aGain.data, "amplitude gain");
assert(rms(pGain.data.subarray((nt - 1) * ns, nt * ns)) > 0, "power gain lost deep samples");

const rt = resample(data, nt, ns, "time", 96, { dtNs, order: 12 });
const rs = resample(data, nt, ns, "scan", 48, { dxM, order: 12 });
finite(rt.data, "time resample");
finite(rs.data, "scan resample");
assert(rt.numSamples === 96 && rt.numTraces === nt, "time resample dimensions are wrong");
assert(rs.numTraces === 48 && rs.numSamples === ns, "scan resample dimensions are wrong");

const bgRemove = slidingBackground(data, nt, ns, 15, "remove");
const bgRetain = slidingBackground(data, nt, ns, 15, "retain");
finite(bgRemove.data, "sliding background remove");
finite(bgRetain.data, "sliding background retain");
assert(bgRemove.numTraces === nt && bgRetain.numSamples === ns, "sliding background dimensions are wrong");

const badSource = new Float32Array(data);
for (let s = 0; s < ns; s++) badSource[10 * ns + s] = 999;
const badFixed = removeBadTraces(badSource, nt, ns, "10", { x: Array.from({ length: nt }, (_, i) => i) });
finite(badFixed.data, "bad trace interpolation");
assert(badFixed.numTraces === nt && badFixed.numSamples === ns, "bad trace replacement must preserve dimensions");
assert(Math.abs(badFixed.data[10 * ns + 20] - 999) > 100, "bad trace was not interpolated");

const band = freqFilter(data, nt, ns, "bp", 40e6, 350e6, { dtNs });
const wk = kFilter(data, nt, ns, "bp", 0.2, 6, dxM);
finite(band.data, "frequency FIR");
finite(wk.data, "wavenumber FIR");
assert(band.numSamples === ns && wk.numTraces === nt, "FIR filters changed dimensions");

const poly = [{ k: -4, f: 0.05 }, { k: 4, f: 0.05 }, { k: 4, f: 0.45 }, { k: -4, f: 0.45 }];
const fkPass = fkFilter(data, nt, ns, { dtNs, dxM, mode: "polygon", action: "pass", polygon: poly });
const fkStop = fkFilter(data, nt, ns, { dtNs, dxM, mode: "polygon", action: "stop", polygon: poly });
const fkFan = fkFilter(data, nt, ns, { dtNs, dxM, mode: "velocity-fan", action: "pass", velocityRange: { min: 0.04, max: 0.25 } });
const fkUp = fkFilter(data, nt, ns, { dtNs, dxM, mode: "up-dip", action: "pass" });
const fkDown = fkFilter(data, nt, ns, { dtNs, dxM, mode: "down-dip", action: "pass" });
for (const [label, result] of [["fk pass", fkPass], ["fk stop", fkStop], ["fk fan", fkFan], ["fk up", fkUp], ["fk down", fkDown]]) {
  finite(result.data, label);
  assert(result.numTraces === nt && result.numSamples === ns, `${label} changed dimensions`);
}
let complementError = 0, signalEnergy = 0;
for (let i = 0; i < data.length; i++) {
  complementError += (fkPass.data[i] + fkStop.data[i] - data[i]) ** 2;
  signalEnergy += data[i] ** 2;
}
assert(Math.sqrt(complementError / signalEnergy) < 1e-5, "F-K polygon pass/stop are not complementary");

const tdUniform = timeDepth(data, nt, ns, { dtNs, vofh: "0.1,0", dzM: 0.05 });
finite(tdUniform.data, "uniform time-depth");
assert(tdUniform.verticalAxisKind === "depth" && tdUniform.depthAxisM.length === tdUniform.numSamples, "time-depth did not return a depth axis");
assert(Math.abs(tdUniform.data[0] - data[0]) < 1e-6, "uniform time-depth should preserve the first sample");

const tdLayered = timeDepth(data, nt, ns, { dtNs, vofh: "0.11,1\n0.08,2\n0.14,0", dzM: 0.04 });
finite(tdLayered.data, "layered time-depth");
for (let i = 1; i < tdLayered.depthAxisM.length; i++) assert(tdLayered.depthAxisM[i] > tdLayered.depthAxisM[i - 1], "layered depth axis must be monotonic");

const smallNt = 18, smallNs = 48, small = synthetic(smallNt, smallNs);
const smallParams = { dtNs, dxM, vofh: "0.1,0" };
const stolt = stoltMigration(small, smallNt, smallNs, smallParams);
const gazdag = gazdagMigration(small, smallNt, smallNs, smallParams);
const split = splitStepMigration(small, smallNt, smallNs, { ...smallParams, dzM: 0.05, zMaxM: 1.2 });
for (const [label, result] of [["stolt", stolt], ["gazdag", gazdag], ["split-step", split]]) {
  finite(result.data, label);
  assert(result.numTraces === smallNt, `${label} changed trace count`);
  assert(result.numSamples > 0, `${label} has no samples`);
}
assert(stolt.numSamples === smallNs && gazdag.numSamples === smallNs, "1-D migrations should preserve sample count");
assert(split.verticalAxisKind === "depth" && split.depthAxisM.length === split.numSamples, "split-step should produce a depth axis");

const klModel = karhunenLoeveFilter(small, smallNt, smallNs, { components: 3, output: "model" });
const klResidual = karhunenLoeveFilter(small, smallNt, smallNs, { components: 3, output: "residual" });
finite(klModel.data, "K-L model");
finite(klResidual.data, "K-L residual");
let klError = 0, klEnergy = 0;
for (let i = 0; i < small.length; i++) {
  klError += (klModel.data[i] + klResidual.data[i] - small[i]) ** 2;
  klEnergy += small[i] ** 2;
}
assert(Math.sqrt(klError / Math.max(1e-12, klEnergy)) < 1e-5, "K-L model + residual should reconstruct input");

const fx = fxDecon(small, smallNt, smallNs, { dtNs, operatorLength: 4, muPercent: 1, flowMHz: 20, fhighMHz: 500 });
finite(fx.data, "F-X deconvolution");
assert(fx.numTraces === smallNt && fx.numSamples === smallNs, "F-X decon dimensions are wrong");

const sparse = sparseDecon(small, smallNt, smallNs, { dtNs, frequencyMHz: 100, lengthSamples: 21, mu: 0.01, iterations: 3 });
finite(sparse.data, "sparse deconvolution");
finite(sparse.predicted, "sparse decon predicted");
assert(sparse.numTraces === smallNt && sparse.numSamples === smallNs, "sparse decon dimensions are wrong");

const attenuation = attenuationAnalysis(data, nt, ns, { dtNs });
finite(attenuation.data, "attenuation analysis");
assert(attenuation.numTraces === 4 && attenuation.numSamples === ns, "attenuation analysis should return four curves");
assert(Number.isFinite(attenuation.powerLaw[0]) && Number.isFinite(attenuation.powerLaw[1]), "invalid power-law fit");
assert(Number.isFinite(attenuation.exponential[0]) && Number.isFinite(attenuation.exponential[1]), "invalid exponential fit");

const geoNt = 80, geoNs = 220;
const geoData = new Float32Array(geoNt * geoNs);
function addGeoPulse(t, s0, amp) {
  for (let k = -4; k <= 4; k++) {
    const s = Math.round(s0 + k);
    if (s < 0 || s >= geoNs) continue;
    const x = k / 2;
    geoData[t * geoNs + s] += amp * (1 - x * x) * Math.exp(-0.5 * x * x);
  }
}
for (let t = 0; t < geoNt; t++) {
  addGeoPulse(t, 62 + 4 * Math.sin(t / 9), 4);
  addGeoPulse(t, 96 + 5 * Math.sin(t / 11 + 0.7), 5);
  addGeoPulse(t, 132 + 4 * Math.sin(t / 13 + 1.1), 4.5);
}
const geo = geologicModel(geoData, geoNt, geoNs, {
  dt: dtNs,
  velocity: 0.1,
  modelDepthMax: 6,
  startDepth: 1.2,
  endDepth: 5,
  maxPeaksPerTrace: 4,
  histPercentile: 0.55,
  supportThreshold: 0.08,
  maxHorizons: 4,
  horizonMinGapM: 0.15,
  preprocess: { dewow: false, dc: false, freqFilter: false, backgroundRemove: false, slidingBg: false },
  gainMethod: "agc"
});
finite(geo.data, "geologic processed data");
assert(geo.horizons.length >= 2, "geologic model should find ordered synthetic horizons");
for (let i = 1; i < geo.horizons.length; i++) {
  for (let t = 0; t < geoNt; t++) {
    assert(geo.horizons[i].line[t] - geo.horizons[i - 1].line[t] >= 0.15, "geologic horizons must remain depth-ordered");
  }
}

const peakTrace = Float32Array.from([0, 1, 0, 0.2, 2, 1, 0, 3, 0]);
assert(JSON.stringify(localMaxima(peakTrace)) === JSON.stringify([1, 4, 7]), "local maxima detection failed");
const peakData = new Float32Array(5 * 16);
for (let t = 0; t < 5; t++) {
  peakData[t * 16 + 5 + (t > 2 ? 1 : 0)] = 1 + t;
  peakData[t * 16 + 10] = 0.5;
}
const picked = pickPeaksNearPoint(peakData, 5, 16, { traceIndex: 2, sampleIndex: 5 }, { radius: 1 });
assert(picked.length === 3 && picked.some(p => p.traceIndex === 2 && p.sampleIndex === 5), "peak picking near point failed");
const troughData = Float32Array.from([0, -2, 0, 0, -0.5, 0]);
const troughPicked = pickPeaksNearPoint(troughData, 1, 6, { traceIndex: 0, sampleIndex: 1 }, { radius: 0, invert: true });
assert(troughPicked.length === 1 && troughPicked[0].sampleIndex === 1, "inverted trough picking should match MATLAB -radar_data behavior");
const seeded = traceFromSeed(peakData, 5, 16, { traceIndex: 2, sampleIndex: 5 }, { halfWindowSamples: 3 });
assert(seeded.length === 5 && seeded[0].traceIndex === 0 && seeded.at(-1).traceIndex === 4, "seed trace tracking failed");

const density = calDensity(9);
const lt = calLossTangent(density);
const cd = calConductivity(9, lt);
assert(Number.isFinite(density) && Number.isFinite(lt) && cd > 0, "material conversion failed");

const h1 = { name: "H1", line: Float32Array.from({ length: 20 }, (_, i) => 1 + 0.1 * Math.sin(i / 3)) };
const h2 = { name: "H2", line: Float32Array.from({ length: 20 }, (_, i) => 2 + 0.1 * Math.cos(i / 4)) };
const model2d = manualHorizonsToModel([h1, h2], {
  numTraces: 20,
  depthSamples: 30,
  depthMaxM: 3,
  distanceStepM: 0.05,
  objects: [{ type: "circle", xM: 0.5, zM: 1.5, radiusM: 0.15, epsr: 20, sigma: 0.01, mu: 1 }]
});
finite(model2d.epsrField, "model2d epsr");
finite(model2d.sigmaField, "model2d sigma");
assert(model2d.epsrField.length === 20 * 30 && Math.max(...model2d.epsrField) >= 20, "manual horizons to model failed");

const layered = generateLayeredDielectric({ size: 48, seed: 7, randomRocks: true });
assert(layered.ep.length === 48 * 48 && layered.boundaries.length === 4, "layered dielectric generation failed");

const interp = gridInterp(Float32Array.from([1, 2, 3, 4]), [0, 1], [0, 1], [0, 0.5, 1], [0, 0.5, 1], "linear");
assert(interp.length === 9 && Math.abs(interp[4] - 2.5) < 1e-6, "grid interpolation failed");
const padded = padGrid(Float32Array.from([1, 2, 3, 4]), [0, 1], [0, 1], 1);
assert(padded.data.length === 16 && padded.x.length === 4 && padded.z.length === 4, "padgrid failed");
const gridEstimate = estimateGridSpacing(9, 1, Float32Array.from([0, 1, 0, -1, 0]), Float64Array.from([0, 1e-10, 2e-10, 3e-10, 4e-10]), 0.02);
assert(gridEstimate.dx > 0 && gridEstimate.fmax > 0, "finddx port failed");

const fdtdModel = manualHorizonsToModel([h1], { numTraces: 18, depthSamples: 18, depthMaxM: 1.8, distanceStepM: 0.05 });
let evenGridRejected = false;
try {
  simulateTm2d(modelToFdtdGrid(fdtdModel), { traceCount: 3, samples: 24, frequencyHz: 300e6, npml: 3, receiverOffsetM: 0.05 });
} catch (error) {
  evenGridRejected = /odd property-grid/.test(error.message);
}
assert(evenGridRejected, "TM FDTD should reject even property-grid dimensions");
const fdtdGrid = prepareFdtdGridFromModel(fdtdModel, { npml: 3, receiverOffsetM: 0.05, airThicknessM: 0.2, antennaZ: -0.1 });
const tm = simulateTm2d(fdtdGrid, { traceCount: 3, samples: 24, frequencyHz: 300e6, npml: 3, receiverOffsetM: 0.05 });
const te = simulateTe2d(fdtdGrid, { traceCount: 3, samples: 20, frequencyHz: 300e6, npml: 3, receiverOffsetM: 0.05 });
finite(tm.data, "TM FDTD");
finite(te.data, "TE FDTD");
assert(tm.numTraces === 3 && tm.numSamples === 24 && te.numTraces === 3, "FDTD dimensions failed");
assert(rms(tm.data) > 0 && rms(te.data) > 0, "FDTD output is empty");

const mat = writeMatFile(variablesFromForwardResult(tm, fdtdModel, { test: true }));
assert(mat.byteLength > 256, "MAT export is too small");

const matlabModelPath = join(softwareRoot, "二维建模正演", "Data", "p5_2_Model.mat");
if (existsSync(matlabModelPath)) {
  const vars = await parseMatFileAsync(arrayBufferFromNodeBuffer(readFileSync(matlabModelPath)));
  assert(vars.ep?.rows === 1000 && vars.ep?.cols === 1000 && vars.cd?.rows === 1000 && vars.mu?.rows === 1000, "compressed MATLAB v5 model fixture was not parsed");
}
const trackingMatPath = join(softwareRoot, "自动峰值检测和追踪", "data_correct.mat");
if (existsSync(trackingMatPath)) {
  const vars = await parseMatFileAsync(arrayBufferFromNodeBuffer(readFileSync(trackingMatPath)));
  assert(Object.keys(vars).length > 0, "compressed peak-tracking MAT fixture was not parsed");
}
const hdf5PulsePath = join(softwareRoot, "二维建模正演", "Data", "P2_pulse_new.mat");
if (existsSync(hdf5PulsePath)) {
  let hdf5Rejected = false;
  try {
    await parseMatFileAsync(arrayBufferFromNodeBuffer(readFileSync(hdf5PulsePath)));
  } catch (error) {
    hdf5Rejected = /MATLAB 7\.3\/HDF5/.test(error.message);
  }
  assert(hdf5Rejected, "MATLAB 7.3/HDF5 pulse fixture should fail with an explicit message");
}

function arrayBufferFromNodeBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

const chDir = join(root, "..", "ch");
if (existsSync(chDir)) {
  const hadFiles = readdirSync(chDir).filter(name => name.toLowerCase().endsWith(".had")).sort();
  let checkedPairs = 0;
  for (const name of hadFiles) {
    const hadPath = join(chDir, name);
    if (statSync(hadPath).size === 0) continue;
    const had = parseHadText(readFileSync(hadPath, "utf8"));
    const hcdPath = join(chDir, name.replace(/\.had$/i, ".hcd"));
    if (!existsSync(hcdPath) || statSync(hcdPath).size === 0) continue;
    const expectedBytes = had.traces * had.samples * (had.dataBit / 8);
    assert(statSync(hcdPath).size === expectedBytes, `${name} HCD size does not match HAD parameters`);
    checkedPairs++;
  }
  assert(checkedPairs > 0, "no non-empty HCD/HAD pairs were verified");

  const hcd16Had = parseHadText(readFileSync(join(chDir, "900_0.had"), "utf8"));
  const hcd16 = parseHcdFile(arrayBufferFromNodeBuffer(readFileSync(join(chDir, "900_0.hcd"))), hcd16Had);
  finite(hcd16.data, "HCD 16-bit import");
  assert(hcd16.numSamples === 1024 && hcd16.numTraces === 6395, "900_0 HCD dimensions are wrong");
  assert(Math.abs(hcd16.meta.dtNs - HCD_DEFAULT_DT_NS) < 1e-9, "900_0 HCD dtNs is wrong");
  assert(hcd16.meta.sourceFormat === ".HCD" && hcd16.meta.dataBit === 16, "900_0 HCD metadata is wrong");

  let manualRejected = false;
  try {
    parseHcdFile(arrayBufferFromNodeBuffer(readFileSync(join(chDir, "900_0.hcd"))), {
      dataBit: 16,
      samples: 1024,
      traces: 6395
    });
  } catch {
    manualRejected = true;
  }
  assert(manualRejected, "manual HCD fallback should be disabled");

  const hcd32Had = parseHadText(readFileSync(join(chDir, "1050-9-7-111_1.had"), "utf8"));
  const hcd32 = parseHcdFile(arrayBufferFromNodeBuffer(readFileSync(join(chDir, "1050-9-7-111_1.hcd"))), hcd32Had);
  finite(hcd32.data, "HCD 32-bit import");
  assert(hcd32.numSamples === 1100 && hcd32.numTraces === 5707, "1050-9-7-111_1 HCD dimensions are wrong");
  assert(hcd32.meta.dataBit === 32 && hcd32.meta.dxM === 0.01, "1050-9-7-111_1 HCD metadata is wrong");
} else {
  console.warn("Skipping HCD sample verification because ../ch was not found");
}

console.log("MATGPR algorithm verification passed");
