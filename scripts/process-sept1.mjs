import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHcdFile, parseHadText } from "../src/io/hcd.js";
import { geologicModel, removeDC, dewow, freqFilter, backgroundRemove, slidingBackground, agc } from "../src/processing/algorithms.js";

const DATA_DIR = "/sessions/brave-tender-darwin/mnt/software/ch";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(dirname(SCRIPT_DIR), "processing_output");
const DATASET = "sept1";

function seismicColor(t) {
  t = Math.max(0, Math.min(1, t));
  return t < 0.5
    ? [0, 0, Math.round(t * 2 * 255)]
    : [Math.round((t - 0.5) * 2 * 255), 0, Math.round((1 - t) * 2 * 255)];
}

function renderRadarProfile(canvas, ds, opts = {}) {
  const w = canvas.width, h = canvas.height;
  const pixels = canvas.data;
  const nt = ds.numTraces, ns = ds.numSamples;
  const min = opts.min ?? -3, max = opts.max ?? 3, range = max - min || 1;
  const sampleMax = opts.sampleMax || ns;
  for (let y = 0; y < h; y++) {
    const s = Math.min(ns - 1, Math.floor(y / h * sampleMax));
    for (let x = 0; x < w; x++) {
      const t = Math.min(nt - 1, Math.floor(x / w * nt));
      const v = ds.data[t * ns + s];
      const c = seismicColor((v - min) / range);
      const i = (y * w + x) * 4;
      pixels[i] = c[0]; pixels[i + 1] = c[1]; pixels[i + 2] = c[2]; pixels[i + 3] = 255;
    }
  }
  if (opts.horizons && opts.horizons.length) {
    const colors = [[255,224,102],[105,219,124],[116,192,252],[255,146,43],[218,119,242],[99,230,190]];
    const md = opts.modelDepthMax || 24;
    for (let hi = 0; hi < opts.horizons.length; hi++) {
      const hzn = opts.horizons[hi];
      const ln = hzn.line || [];
      const [cr, cg, cb] = colors[hi % colors.length];
      for (let x = 0; x < w; x++) {
        const t = Math.min(ln.length - 1, Math.floor(x / w * ln.length));
        let py = Math.round(ln[t] / md * h);
        if (py < 0 || py >= h) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = py + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -3; dx <= 3; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const i = (yy * w + xx) * 4;
            const alpha = (dx === 0 && dy === 0) ? 1 : 0.35;
            pixels[i] = Math.round(cr * alpha + pixels[i] * (1 - alpha));
            pixels[i + 1] = Math.round(cg * alpha + pixels[i + 1] * (1 - alpha));
            pixels[i + 2] = Math.round(cb * alpha + pixels[i + 2] * (1 - alpha));
          }
        }
      }
    }
  }
}

function renderLayerModel(canvas, result) {
  const w = canvas.width, h = canvas.height;
  const pixels = canvas.data;
  const nt = result.modelTraces, nz = result.modelSamples;
  const palette = [[234,215,183],[214,191,130],[183,193,138],[143,182,161],[120,149,178],[111,116,132],[68,72,87]];
  for (let y = 0; y < h; y++) {
    const zi = Math.min(nz - 1, Math.floor(y / h * nz));
    for (let x = 0; x < w; x++) {
      const ti = Math.min(nt - 1, Math.floor(x / w * nt));
      const c = palette[result.modelData[zi * nt + ti] || 0];
      const i = (y * w + x) * 4;
      pixels[i] = c[0]; pixels[i + 1] = c[1]; pixels[i + 2] = c[2]; pixels[i + 3] = 255;
    }
  }
  const lc = [16, 24, 40];
  for (const hzn of result.horizons) {
    for (let x = 0; x < w; x++) {
      const t = Math.min(hzn.line.length - 1, Math.floor(x / w * hzn.line.length));
      let py = Math.round(hzn.line[t] / result.modelDepthMax * h);
      if (py < 0 || py >= h) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = py + dy;
        if (yy < 0 || yy >= h) continue;
        const i = (yy * w + x) * 4;
        pixels[i] = lc[0]; pixels[i + 1] = lc[1]; pixels[i + 2] = lc[2];
      }
    }
  }
}

async function savePNG(canvas, path) {
  const { default: pkg } = await import("pngjs");
  const PNG = pkg.PNG;
  const png = new PNG({ width: canvas.width, height: canvas.height });
  png.data = Buffer.from(canvas.data);
  const buf = PNG.sync.write(png);
  await writeFile(path, buf);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const outDir = join(OUT_DIR, DATASET);
  await mkdir(outDir, { recursive: true });

  console.log("Processing: " + DATASET);
  console.log("[1/6] Parsing HCD+HAH files...");
  const hadPath = join(DATA_DIR, "九月一号_0.had");
  const hcdPath = join(DATA_DIR, "九月一号_0.hcd");
  const hadText = await readFile(hadPath, "utf-8");
  const params = parseHadText(hadText);
  console.log("  Samples: " + params.samples + ", Traces: " + params.traces);
  console.log("  Time window: " + params.timeWindowNs + "ns, dx: " + params.dxM + "m");
  const hcdBuf = await readFile(hcdPath);
  const ds = parseHcdFile(hcdBuf.buffer.slice(hcdBuf.byteOffset, hcdBuf.byteOffset + hcdBuf.byteLength), params);
  console.log("  Parsed: " + ds.numTraces + " x " + ds.numSamples);
  const nt = ds.numTraces, ns = ds.numSamples;
  const dtNs = params.timeWindowNs / params.samples;
  const velocity = 0.1;

  console.log("[2/6] Preprocessing...");
  let r = ds.data;
  r = dewow(r, nt, ns).data;        console.log("  dewow done");
  r = removeDC(r, nt, ns).data;      console.log("  removeDC done");
  r = freqFilter(r, nt, ns, "bp", 20e6, 400e6, 1/(dtNs*1e-9)).data; console.log("  freqFilter done");
  r = backgroundRemove(r, nt, ns).data; console.log("  bgRemove done");
  r = slidingBackground(r, nt, ns, 25, "remove").data; console.log("  slidingBg done");
  r = agc(r, nt, ns, 80, true).data; console.log("  AGC done");

  console.log("[3/6] Geological modeling...");
  const result = geologicModel(r, nt, ns, {
    dt: dtNs, dx: params.dxM, velocity: velocity,
    loMHz: 20, hiMHz: 400, bgWidth: 25, agcWindow: 80,
    modelDepthMax: Math.min(12, velocity * dtNs * ns / 2),
    maxPeaksPerTrace: 6, histPercentile: 0.65, supportThreshold: 0.18
  });
  console.log("  Horizons: " + result.horizons.length);
  for (const h of result.horizons) {
    console.log("  " + h.name + ": " + h.medianDepth.toFixed(2) + "m - " + h.layerName);
  }

  console.log("[4/6] Rendering radar profile...");
  const rc = { width: 3200, height: 2400, data: new Uint8ClampedArray(3200*2400*4) };
  renderRadarProfile(rc, { data: r, numTraces: nt, numSamples: ns }, {
    min: -3, max: 3, horizons: result.horizons,
    modelDepthMax: result.modelDepthMax,
    sampleMax: Math.ceil(result.modelDepthMax / result.depthStep)
  });
  await savePNG(rc, join(outDir, "radar_profile.png"));
  console.log("  Saved radar_profile.png");

  console.log("[5/6] Rendering layer model...");
  const mc = { width: 3200, height: 1200, data: new Uint8ClampedArray(3200*1200*4) };
  renderLayerModel(mc, result);
  await savePNG(mc, join(outDir, "geologic_model.png"));
  console.log("  Saved geologic_model.png");

  console.log("[6/6] Saving JSON...");
  const compact = {
    velocity: result.velocity, epsilonR: result.epsilonR,
    depthStep: result.depthStep, modelDepthMax: result.modelDepthMax,
    numTraces: nt, numSamples: ns, horizons: result.horizons.map(h => ({
      name: h.name, meanDepth: h.meanDepth, medianDepth: h.medianDepth,
      minDepth: h.minDepth, maxDepth: h.maxDepth, support: h.support,
      layerName: h.layerName, meaning: h.meaning, line: Array.from(h.line)
    }))
  };
  await writeFile(join(outDir, "model.json"), JSON.stringify(compact, null, 2));
  console.log("  Saved model.json");

  console.log("\n=== RESULTS ===");
  console.log("Dataset: " + DATASET + " (" + nt + " traces x " + ns + " samples)");
  console.log("Velocity: " + velocity + " m/ns, eps_r: " + result.epsilonR.toFixed(2));
  console.log("Model depth: 0-" + result.modelDepthMax.toFixed(1) + "m");
  for (const h of result.horizons) {
    console.log("  " + h.name + " at " + h.medianDepth.toFixed(2) + "m: " + h.meaning);
  }
  console.log("Output: " + outDir);
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
