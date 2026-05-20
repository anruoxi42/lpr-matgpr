import {
  agc,
  amplitudeGain,
  dewow,
  fkFilter,
  freqFilter,
  gagc,
  kFilter,
  powerGain,
  resample,
  slidingBackground,
  spectrum
} from "../src/processing/algorithms.js";

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

console.log("MATGPR algorithm verification passed");
