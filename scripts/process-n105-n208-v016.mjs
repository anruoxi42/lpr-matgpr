import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { parse2BFile } from "../src/io/twoB.js";
import { geologicModel, timeDepth } from "../src/processing/algorithms.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const inputPath = "C:/Users/anruoxi/Desktop/software/N105-N208.2b";
const outDir = join(root, "analysis_outputs", "n105_n208_v016");
const dtNs = 0.3125;
const dxM = 0.05;
const velocity = 0.16;
const epsilonR = (0.299792458 / velocity) ** 2;
const modelDepthMax = 40;
const depthStepM = velocity * dtNs / 2;

function percentile(values, p) {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  return values[Math.max(0, Math.min(values.length - 1, Math.floor((values.length - 1) * p)))];
}

function absClip(data, samples, traces, sampleMax) {
  const vals = [];
  const strideT = Math.max(1, Math.floor(traces / 800));
  const strideS = Math.max(1, Math.floor(sampleMax / 800));
  for (let t = 0; t < traces; t += strideT) {
    for (let s = 0; s < sampleMax; s += strideS) vals.push(Math.abs(data[t * samples + s]));
  }
  return Math.max(1e-6, percentile(vals, 0.985));
}

function seismic(v) {
  const t = Math.max(-1, Math.min(1, v));
  if (t < 0) {
    const a = 1 + t;
    return [Math.round(40 * a), Math.round(115 * a), Math.round(255 * (0.55 + 0.45 * a))];
  }
  return [Math.round(255 * (0.55 + 0.45 * t)), Math.round(120 * (1 - t)), Math.round(60 * (1 - t))];
}

function setPixel(png, x, y, rgb, alpha = 255) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const i = (y * png.width + x) * 4;
  png.data[i] = rgb[0];
  png.data[i + 1] = rgb[1];
  png.data[i + 2] = rgb[2];
  png.data[i + 3] = alpha;
}

function line(png, x0, y0, x1, y1, rgb) {
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) setPixel(png, x0 + ox, y0 + oy, [15, 18, 24]);
    setPixel(png, x0, y0, rgb);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

function overlayHorizons(png, horizons, depthMax, rgb = [255, 235, 70]) {
  for (const h of horizons) {
    let px = 0, py = Math.round((h.line[0] / depthMax) * (png.height - 1));
    for (let x = 1; x < png.width; x++) {
      const t = Math.round((x / (png.width - 1)) * (h.line.length - 1));
      const y = Math.round((h.line[t] / depthMax) * (png.height - 1));
      line(png, px, py, x, y, rgb);
      px = x; py = y;
    }
  }
}

function renderRadarDepth(data, traces, samples, depthAxis, horizons, outputPath, depthMax = modelDepthMax) {
  const width = traces;
  const height = 900;
  const png = new PNG({ width, height });
  const sampleMax = Math.min(samples - 1, Math.max(2, Math.floor(depthMax / (depthAxis[1] - depthAxis[0]))));
  const clip = absClip(data, samples, traces, sampleMax);
  for (let y = 0; y < height; y++) {
    const s = Math.min(sampleMax, Math.floor((y / (height - 1)) * sampleMax));
    for (let x = 0; x < width; x++) {
      const t = Math.min(traces - 1, x);
      const rgb = seismic(data[t * samples + s] / clip);
      setPixel(png, x, y, rgb);
    }
  }
  overlayHorizons(png, horizons, depthMax);
  return writeFile(outputPath, PNG.sync.write(png));
}

function renderModel(modelData, traces, samples, layerNames, horizons, outputPath, depthMax = modelDepthMax) {
  const width = traces;
  const height = 800;
  const png = new PNG({ width, height });
  const colors = [
    [231, 213, 156],
    [184, 187, 130],
    [151, 161, 112],
    [120, 126, 104],
    [93, 104, 118],
    [70, 78, 93],
    [38, 44, 54]
  ];
  for (let y = 0; y < height; y++) {
    const s = Math.min(samples - 1, Math.floor((y / (height - 1)) * (samples - 1)));
    for (let x = 0; x < width; x++) {
      const t = Math.min(traces - 1, x);
      const layer = modelData[s * traces + t] || 0;
      setPixel(png, x, y, colors[Math.min(layer, colors.length - 1)]);
    }
  }
  overlayHorizons(png, horizons, depthMax, [20, 28, 35]);
  return writeFile(outputPath, PNG.sync.write(png));
}

function renderCombined(radarPath, modelPath, outputPath) {
  const radar = PNG.sync.read(Buffer.from(radarPath));
  const model = PNG.sync.read(Buffer.from(modelPath));
  const gap = 12;
  const width = Math.max(radar.width, model.width);
  const height = radar.height + model.height + gap;
  const out = new PNG({ width, height });
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 8; out.data[i + 1] = 12; out.data[i + 2] = 18; out.data[i + 3] = 255;
  }
  PNG.bitblt(radar, out, 0, 0, radar.width, radar.height, 0, 0);
  PNG.bitblt(model, out, 0, 0, model.width, model.height, 0, radar.height + gap);
  return writeFile(outputPath, PNG.sync.write(out));
}

await mkdir(outDir, { recursive: true });
const fileBytes = await readFile(inputPath);
const parsed = parse2BFile(fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength));
parsed.meta.dtNs = dtNs;
parsed.meta.dxM = dxM;
parsed.meta.sampleRateHz = 1 / (dtNs * 1e-9);

console.log(`Input: ${inputPath}`);
console.log(`Shape: ${parsed.numTraces} traces x ${parsed.numSamples} samples`);
console.log(`Depth conversion: v=${velocity} m/ns, epsilon_r=${epsilonR.toFixed(3)}, dz=${depthStepM.toFixed(4)} m`);

const model = geologicModel(parsed.data, parsed.numTraces, parsed.numSamples, {
  dt: dtNs,
  dx: dxM,
  velocity,
  loMHz: 20,
  hiMHz: 900,
  bgWidth: 25,
  agcWindow: 80,
  modelDepthMax,
  modelSamples: 800,
  startDepth: 2,
  endDepth: 35,
  minHorizonSeparation: 1.0,
  maxHorizons: 6
});

const depth = timeDepth(model.data, parsed.numTraces, parsed.numSamples, {
  dtNs,
  vofh: `${velocity},0`,
  dzM: depthStepM
});

const radarPng = join(outDir, "n105_n208_v016_depth_profile.png");
const modelPng = join(outDir, "n105_n208_v016_geologic_model.png");
const combinedPng = join(outDir, "n105_n208_v016_depth_and_model.png");
await renderRadarDepth(depth.data, depth.numTraces, depth.numSamples, depth.depthAxisM, model.horizons, radarPng);
await renderModel(model.modelData, model.modelTraces, model.modelSamples, model.layerNames, model.horizons, modelPng);
await renderCombined(await readFile(radarPng), await readFile(modelPng), combinedPng);

const horizons = model.horizons.map((h, i) => ({
  name: h.name,
  meanDepthM: h.meanDepth,
  medianDepthM: h.medianDepth,
  minDepthM: h.minDepth,
  maxDepthM: h.maxDepth,
  supportPeaks: h.support,
  meanStrength: h.meanStrength,
  layerName: h.layerName,
  meaning: h.meaning,
  lowerBoundaryForLayerAbove: i === 0 ? "first continuous reflector" : `boundary ${h.name}`
}));

const summary = {
  generatedAt: new Date().toISOString(),
  inputPath,
  note: "Requested folder C:/Users/anruoxi/Desktop/software/N105-N108 was not present; processed the only available N105-series .2B file, N105-N208.2b.",
  dimensions: {
    traces: parsed.numTraces,
    samples: parsed.numSamples,
    processedDepthSamples: depth.numSamples,
    modelSamples: model.modelSamples
  },
  parameters: {
    dtNs,
    dxM,
    velocityMPerNs: velocity,
    epsilonR,
    vofh: [[velocity, 0]],
    depthStepM,
    modelDepthMaxM: modelDepthMax,
    bandpassMHz: [20, 900],
    backgroundWidthTraces: 25,
    gaussianAgcWindowSamples: 80
  },
  operations: [
    "Read CE-3 .2B records with 8307 bytes per trace and 2048 float32 samples per trace.",
    "Set processing time sample interval to dt=0.3125 ns for this CE-3 LPR section.",
    "Remove per-trace DC mean.",
    "Apply MATGPR-style FIR bandpass/dewow from 20 MHz to 900 MHz.",
    "Remove global mean trace background.",
    "Apply 25-trace sliding background suppression.",
    "Apply Gaussian AGC with an 80-sample window.",
    "Convert two-way time to depth with vofh=[0.16,0], dz=0.025 m.",
    "Compute smoothed absolute reflection energy.",
    "Pick and track continuous reflection horizons, then build a categorical 2-D geologic model."
  ],
  horizons,
  layerNamesTopToBottom: model.layerNames,
  interpretation: [
    "The first reflector marks the base of disturbed shallow regolith.",
    "Middle reflectors define layered regolith packages with dielectric contrasts.",
    "The strongest persistent reflector package is interpreted as a more coherent buried interface or blocky ejecta/regolith transition.",
    "Deeper intervals are weaker and less continuous, so their interpretation has higher uncertainty."
  ],
  caveats: [
    "Depth scales linearly with the assumed velocity; if v changes, all horizon depths scale with it.",
    "This is automatic MATGPR-like processing and horizon tracking, not a full electromagnetic inversion.",
    "Distance uses dx=0.05 m per trace unless reliable position metadata is supplied."
  ],
  outputs: {
    depthProfilePng: radarPng,
    geologicModelPng: modelPng,
    combinedPng,
    summaryJson: join(outDir, "n105_n208_v016_summary.json"),
    horizonsJson: join(outDir, "n105_n208_v016_horizons.json")
  }
};

await writeFile(summary.outputs.summaryJson, JSON.stringify(summary, null, 2), "utf8");
await writeFile(summary.outputs.horizonsJson, JSON.stringify({ horizons: model.horizons, layerNames: model.layerNames }, null, 2), "utf8");
await writeFile(join(outDir, "n105_n208_v016_depth.float32"), Buffer.from(depth.data.buffer, depth.data.byteOffset, depth.data.byteLength));
await writeFile(join(outDir, "n105_n208_v016_model.uint8"), Buffer.from(model.modelData.buffer, model.modelData.byteOffset, model.modelData.byteLength));

console.log(JSON.stringify({
  outDir,
  epsilonR,
  depthStepM,
  horizons: horizons.map(h => ({
    name: h.name,
    meanDepthM: Number(h.meanDepthM.toFixed(2)),
    rangeM: [Number(h.minDepthM.toFixed(2)), Number(h.maxDepthM.toFixed(2))],
    layerName: h.layerName
  })),
  combinedPng
}, null, 2));
