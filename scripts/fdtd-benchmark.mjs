import { performance } from "node:perf_hooks";
import { manualHorizonsToModel, prepareFdtdGridFromModel } from "../src/modeling/model2d.js";
import { simulateTm2d } from "../src/modeling/fdtd/tm2d.js";
import { simulateTe2d } from "../src/modeling/fdtd/te2d.js";

function rms(data) {
  let sum = 0;
  for (const value of data) sum += Number(value) * Number(value);
  return Math.sqrt(sum / Math.max(1, data.length));
}

function finite(data) {
  for (const value of data) if (!Number.isFinite(Number(value))) return false;
  return true;
}

function runCase(name, fn) {
  const start = performance.now();
  const result = fn();
  const elapsedMs = performance.now() - start;
  return {
    name,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    traces: result.numTraces,
    samples: result.numSamples,
    rms: Number(rms(result.data).toExponential(6)),
    finite: finite(result.data),
    backend: "js-worker-core"
  };
}

const horizon = { line: Float32Array.from({ length: 21 }, (_, i) => 0.55 + 0.08 * Math.sin(i / 4)) };
const model = manualHorizonsToModel([horizon], {
  numTraces: 21,
  depthSamples: 21,
  depthMaxM: 1.8,
  distanceStepM: 0.05
});
const fdtd = {
  traceCount: 4,
  samples: 28,
  frequencyHz: 300e6,
  npml: 3,
  receiverOffsetM: 0.05,
  airThicknessM: 0.2,
  antennaZ: -0.1
};
const grid = prepareFdtdGridFromModel(model, fdtd);
const cases = [
  runCase("tm-small", () => simulateTm2d(grid, fdtd)),
  runCase("te-small", () => simulateTe2d(grid, fdtd))
];

console.log(JSON.stringify({
  createdAt: new Date().toISOString(),
  grid: { nx: grid.nx, nz: grid.nz, npml: grid.npml },
  cases
}, null, 2));
