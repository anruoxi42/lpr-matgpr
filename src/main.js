import { RECORD_SIZE, SAMPLES_PER_TRACE, parse2BFile, write2BFile, writeMgpJson, writeSEGYLike, writeSEGYFile, writeDZTFile } from "./io/twoB.js";
import { HCD_DEFAULT_AMP, parseHadText, parseHcdFile } from "./io/hcd.js";
import { IpdStore } from "./processing/ipdStore.js";
import { depthAxisFromVofh, parseVofh, spectrum, fkSpectrum } from "./processing/algorithms.js";
import { RadarRenderer, drawLine } from "./visualization/radarRenderer.js";

const store = new IpdStore();
const worker = new Worker(new URL("./workers/processingWorker.js", import.meta.url), { type: "module" });
const pending = new Map();
let displaySource = "current";
let threeVolume = null;
let velocityPoints = [];
let model = { background: { epsr: 9, sigma: 0, mu: 1 }, objects: [] };
let modelTool = "select";
let radarSelections = [];
let radarAnnotations = [];
let lastMergedSelection = null;
let geologyResult = null;
let geologyPipelineState = {};
let activeGeoPipelineOp = "";
let manualInterpretationState = null;
let manualGeoTool = "draw";
let manualGeoDrag = null;
let manualFeatureResult = null;
let manualModelResult = null;
let manualCanvasRender = null;
let dataManagerSelection = new Set();
let velocityRenderer = null;
let velocityPreviewPoint = null;
let velocityFixedPoint = null;
let depthAxisEnabled = false;
let currentVofhText = "0.1,0";
let lastGeoDatasetKey = "";

const geoPipelineDefs = [
  ["geo-energy-envelope", "Hilbert 多属性包络", "计算包络、相位、瞬时频率、相干性等界面识别属性。"],
  ["geo-smooth-2d", "二维/边缘保持平滑", "增强连续同相轴并降低孤立噪声。"],
  ["geo-trace-peaks", "逐道候选峰检测", "按深度归一和最小波长约束提取候选反射点。"],
  ["geo-depth-histogram", "深度/倾角候选统计", "统计候选界面的深度分布和连续性趋势。"],
  ["geo-cluster-peaks", "二维事件聚类", "将候选点按深度、倾角和横向连续性聚为事件。"],
  ["geo-merge-clusters", "事件聚类合并", "合并相近或重复的候选界面事件。"],
  ["geo-support-select", "综合支持度筛选", "按覆盖率、SNR、相干性和连续段长度筛选候选层位。"],
  ["geo-track-horizons", "Viterbi 层位追踪", "用全局代价追踪连续层位，降低逐道跳层风险。"],
  ["geo-line-smooth", "置信度加权线平滑", "在保留可信局部变化的同时平滑层位线。"],
  ["geo-stratigraphy", "地层顺序约束", "约束层位不交叉，并允许缺失段和尖灭。"],
  ["geo-classify-model", "地层分类模型生成", "根据层位线生成地质分层模型和不确定性图。"]
];

const algorithmDocs = [
  ["不良道插值替换", "沿道向找相邻有效道，对坏道位置做线性/三次插值，保留原始道数和采样点。", "输入坏道范围，如 5-9,22；适合空道、饱和道、异常尖峰道修复。输出进入 Output Data。"],
  ["重采样/等间距", "使用 sinc 插值在时间轴或扫描轴重新采样，统一样点数、道数或空间间距。", "设置目标 samples/traces、当前 dt/dx 与 sinc 半阶；用于多剖面对齐、.2B 导出前恢复 2048 样点。"],
  ["AGC/增益", "用局部能量窗或衰减曲线估计随深度变化的振幅补偿系数，增强深部弱反射。", "Standard/Gaussian AGC 设置窗口；Power/Amplitude Gain 设置幂次或衰减曲线。结果只进 Output Data，确认后 Hold。"],
  ["K-L/SVDS", "把雷达数据矩阵分解为主成分，连续背景通常集中在低阶分量，异常或噪声进入残差。", "设置 components 和 output=model/residual；适合提取背景模型、突出局部异常或压制低秩干扰。"],
  ["F-X Deconvolution", "在频率-空间域用相邻道预测关系重建相干事件，随机噪声因不可预测被削弱。", "设置预测算子长度、预白化和处理频带；适合横向连续反射增强。"],
  ["Sparse Deconvolution", "以 Ricker 子波卷积模型反演稀疏反射系数，用 L1 正则压缩波形。", "设置主频、子波长度、mu 和迭代次数；输出 reflectivity 可突出薄层界面。"],
  ["Predictive Deconvolution", "根据自相关建立预测误差滤波器，削弱周期性振铃、多次波或拖尾。", "设置 operatorLength、predictionLength 和预白化比例；常用于振铃明显的数据。"],
  ["Stolt/Gazdag/PSPI/Split-step 偏移", "依据电磁波传播速度把绕射双曲线和倾斜反射回归到地下真实位置。", "输入速度或 vofh、dt/dx、dz/zMax；Stolt/Gazdag 偏 1-D 速度，PSPI/Split-step 支持更复杂速度近似。"],
  ["时深转换", "按层状速度模型把双程走时采样映射成深度采样。", "输入 vofh=[velocity, thickness] 与 dz；结果带 depthAxisM，可在雷达剖面切换深度轴。"],
  ["瞬时属性/质心频率", "Hilbert 解析信号给出包络、相位、瞬时频率；质心频率表示频谱能量重心。", "用于识别强反射、相位突变、频散和介质变化；结果进入 Output Data 或曲线窗口。"],
  ["衰减分析", "统计每个深度样点的解析信号功率，并拟合 power-law 与 exponential 衰减曲线。", "用于判断介质吸收、深部能量衰减和资料质量；结果在曲线窗口显示并可保存为 Output Data。"],
  ["静校正", "根据高程、表层速度和基准面计算每道时间零点修正量，校正近地表起伏影响。", "输入高程序列、表层/次表层速度与基准面；适合地表不平或天线高度变化数据。"],
  ["地质建模流水线", "能量包络 -> 二维平滑 -> 峰值 -> 深度直方图聚类 -> 聚类合并 -> 支持度筛选 -> 层位追踪 -> 线平滑 -> 层序约束 -> 地层分类。", "可一键自动追踪，也可在 Geologic Modeling 地质建模页逐步运行，每步都会显示用途和中间统计。"]
];

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const radar = new RadarRenderer($("#radar-canvas"), $("#radar-wrap"), (t, s, amp) => {
  const y = t == null ? null : radar.verticalReadout(s).text;
  $("#cursor-status").textContent = t == null ? "" : `道 ${t} · ${y} · 振幅 ${amp.toFixed(5)}`;
  if (t != null) syncTraceIndex(t, false);
});

radar.callbacks = {
  onSelection(sel) {
    radarSelections.push(normalizeSelection(sel));
    updateSelectionPanel();
    toast(`选区 #${radarSelections.length} 已添加`);
  },
  onAnnotation(ann) {
    radarAnnotations.push(ann);
    radar.setAnnotations(radarAnnotations);
    updateAnnotationPanel();
    toast("标注已添加");
  },
  onMeasure(a, b) {
    toast(`测量: Δ道 ${Math.abs(b.t - a.t)}, Δ样点 ${Math.abs(b.s - a.s)}`);
  }
};

function currentDisplayed() {
  return displaySource === "output" && store.output ? store.output : store.current;
}
function toast(msg, type = "ok") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  $("#toast").appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function runWorker(op, dataset, params = {}) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const copy = new Float32Array(dataset.data);
    worker.postMessage({ id, op, params: normalizeWorkerParams(dataset, params), dataset: { ...dataset, data: copy.buffer } }, [copy.buffer]);
  });
}
worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  data.ok ? p.resolve(data.result) : p.reject(new Error(data.error));
};

function refresh() {
  const ds = currentDisplayed();
  const rp = getEffectiveRadarParams(store.current);
  $("#dataset-title").textContent = store.ipd ? `${store.ipd.name} · ${displaySource === "output" && store.output ? "Output Data" : "Current Input Data"}` : "未加载数据";
  $("#drop-zone").classList.toggle("hidden", !!store.current);
  radar.setDataset(ds);
  applyDepthAxisMode();
  $("#state-panel").innerHTML = store.ipd ? [
    row("Current", `${store.current.numTraces} 道 × ${store.current.numSamples} 样点`),
    row("Output", store.output ? `${store.output.numTraces} 道 × ${store.output.numSamples} 样点，待验收` : "无"),
    row("dt / dx", `${rp.dtNs.toFixed(4)} ns · ${rp.dxM.toFixed(4)} m`),
    row("速度", `${rp.velocityMPerNs.toFixed(3)} m/ns · εr ${rp.epsilonR.toFixed(2)}`),
    row("历史", `${store.ipd.history.length} 步`),
    row("格式", store.current.meta?.sourceFormat || ".2B")
  ].join("") : "暂无数据";
  $("#history-panel").innerHTML = store.ipd?.history.length ? store.ipd.history.map((h, i) => `<div class="history-item"><b>${i + 1}. ${h.name}</b><br><span>${h.createdAt || ""}</span><br><code>${JSON.stringify(h.params || {})}</code></div>`).join("") : "暂无历史";
  renderSideDatasetList();
  updateVelocityList();
  renderDataManager();
  renderThree();
}
function row(k, v) { return `<div><span class="muted">${k}</span><br><b>${v}</b></div>`; }
store.addEventListener("change", refresh);

function formatVofh(vofh) {
  return Array.isArray(vofh) ? vofh.map(row => `${row[0]},${row[1] ?? 0}`).join("\n") : (typeof vofh === "string" ? vofh : "");
}

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function optionalNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

function medianPositive(values) {
  if (!values?.length) return NaN;
  const clean = Array.from(values).filter(v => Number.isFinite(Number(v)) && Number(v) > 0).map(Number).sort((a, b) => a - b);
  return clean.length ? clean[Math.floor(clean.length / 2)] : NaN;
}

function axis(count, step, offset = 0) {
  const out = new Float32Array(Math.max(0, Math.floor(count || 0)));
  for (let i = 0; i < out.length; i++) out[i] = offset + i * step;
  return out;
}

function velocityFromEps(eps, fallback = 0.1) {
  const er = optionalNumber(eps);
  return Number.isFinite(er) ? 0.299792458 / Math.sqrt(er) : fallback;
}

function epsFromVelocity(velocity) {
  const v = finiteNumber(velocity, 0.1);
  return (0.299792458 / v) ** 2;
}

function buildRadarMetadata(dataset) {
  const meta = { ...(dataset.meta || {}) };
  const isHcd = String(meta.sourceFormat || "").toUpperCase() === ".HCD";
  const dtDefault = finiteNumber(meta.dtNs ?? dataset.dtNs, isHcd ? 0.3125 : 0.625);
  const dxDefault = finiteNumber(meta.dxM ?? dataset.dxM, isHcd ? 1 : 0.05);
  const fileVelocity = medianPositive(meta.velocity);
  const antennaFreq = optionalNumber(meta.antennaFreqMHz ?? meta.frequencyMHz);
  const saved = meta.radarParams || {};
  const velocity = finiteNumber(saved.velocityMPerNs ?? saved.velocity ?? 0.1, 0.1);
  const vofhText = String(saved.vofhText || saved.vofh || `${velocity},0`);
  const depthMax = finiteNumber(saved.depthMaxM, Math.max(0, (dataset.numSamples || 1) - 1) * dtDefault * velocity / 2);
  const radarParams = {
    dtNs: finiteNumber(saved.dtNs, dtDefault),
    dxM: finiteNumber(saved.dxM, dxDefault),
    velocityMPerNs: velocity,
    vofhText,
    epsilonR: finiteNumber(saved.epsilonR, epsFromVelocity(velocity)),
    antennaFreqMHz: Number.isFinite(antennaFreq) ? antennaFreq : "",
    freqLowMHz: finiteNumber(saved.freqLowMHz, 20),
    freqHighMHz: finiteNumber(saved.freqHighMHz, Number.isFinite(antennaFreq) ? Math.min(900, antennaFreq * 2.5) : 900),
    q: saved.q ?? "",
    timeZeroSample: Number.isFinite(Number(saved.timeZeroSample)) ? Number(saved.timeZeroSample) : 0,
    depthDzM: finiteNumber(saved.depthDzM, 0.02),
    depthMaxM: depthMax
  };
  const headerSuggestions = {
    ...(meta.headerSuggestions || {}),
    sourceFormat: meta.sourceFormat || ".2B",
    dtNs: dtDefault,
    dtSource: isHcd ? ".hcd/.had MATLAB default" : ".2B format default, not parsed from file",
    dxM: dxDefault,
    dxSource: isHcd ? ".had TRACE INCREMENT / USER DISTANCE INTERVAL" : ".2B position-derived median or format default",
    fileVelocityMPerNs: Number.isFinite(fileVelocity) ? fileVelocity : "",
    fileVelocityNote: ".2B record velocity is preserved as a suggestion only, not used as subsurface radar velocity",
    soilVelocityRaw: Number.isFinite(Number(meta.soilVelocityRaw)) ? Number(meta.soilVelocityRaw) : "",
    antennaFreqMHz: Number.isFinite(antennaFreq) ? antennaFreq : "",
    frequencyMHz: Number.isFinite(Number(meta.frequencyMHz)) ? Number(meta.frequencyMHz) : "",
    timeWindowNs: Number.isFinite(Number(meta.timeWindowNs)) ? Number(meta.timeWindowNs) : "",
    antenna: meta.antenna || ""
  };
  meta.radarParams = radarParams;
  meta.headerSuggestions = headerSuggestions;
  meta.dtNs = radarParams.dtNs;
  meta.dxM = radarParams.dxM;
  meta.sampleRateHz = 1 / (radarParams.dtNs * 1e-9);
  meta.timeAxisNs = axis(dataset.numSamples, radarParams.dtNs, radarParams.timeZeroSample * radarParams.dtNs);
  meta.tt2w = meta.timeAxisNs;
  meta.distanceAxisM = axis(dataset.numTraces, radarParams.dxM);
  meta.x = meta.distanceAxisM;
  meta.vofh = radarParams.vofhText;
  return { ...dataset, meta, dtNs: radarParams.dtNs, dxM: radarParams.dxM };
}

function getEffectiveRadarParams(ds, overrides = {}) {
  const meta = ds?.meta || {};
  const rp = meta.radarParams || {};
  const hs = meta.headerSuggestions || {};
  const fallbackDt = String(meta.sourceFormat || "").toUpperCase() === ".HCD" ? 0.3125 : 0.625;
  const dtNs = finiteNumber(overrides.dtNs ?? overrides.dt ?? rp.dtNs ?? meta.dtNs ?? hs.dtNs, fallbackDt);
  const dxM = finiteNumber(overrides.dxM ?? overrides.dx ?? rp.dxM ?? meta.dxM ?? hs.dxM, 0.05);
  const vofhText = String(overrides.vofh ?? overrides.vofhText ?? rp.vofhText ?? meta.vofh ?? "0.1,0");
  const vofhVelocity = parseVofh(vofhText || "0.1,0")[0]?.[0];
  const velocityMPerNs = finiteNumber(overrides.velocity ?? overrides.velocityMPerNs ?? rp.velocityMPerNs ?? vofhVelocity, 0.1);
  const epsilonR = finiteNumber(overrides.epsilonR ?? rp.epsilonR, epsFromVelocity(velocityMPerNs));
  const qRaw = overrides.q ?? rp.q;
  return {
    dtNs,
    dxM,
    dt: dtNs,
    dx: dxM,
    velocity: velocityMPerNs,
    velocityMPerNs,
    vofh: vofhText,
    vofhText,
    epsilonR,
    antennaFreqMHz: optionalNumber(overrides.antennaFreqMHz ?? rp.antennaFreqMHz ?? hs.antennaFreqMHz),
    freqLowMHz: finiteNumber(overrides.freqLowMHz ?? overrides.flowMHz ?? overrides.loMHz ?? rp.freqLowMHz, 20),
    freqHighMHz: finiteNumber(overrides.freqHighMHz ?? overrides.fhighMHz ?? overrides.hiMHz ?? rp.freqHighMHz, 900),
    q: qRaw === "" || qRaw == null ? "" : (Number.isFinite(Number(qRaw)) ? Number(qRaw) : ""),
    timeZeroSample: Number.isFinite(Number(overrides.timeZeroSample ?? rp.timeZeroSample)) ? Number(overrides.timeZeroSample ?? rp.timeZeroSample) : 0,
    depthDzM: finiteNumber(overrides.depthDzM ?? overrides.dzM ?? overrides.dz ?? rp.depthDzM, 0.02),
    depthMaxM: finiteNumber(overrides.depthMaxM ?? overrides.zMaxM ?? overrides.zMax ?? rp.depthMaxM, Math.max(0, (ds?.numSamples || 1) - 1) * dtNs * velocityMPerNs / 2)
  };
}

function normalizeWorkerParams(ds, params = {}) {
  const rp = getEffectiveRadarParams(ds, params);
  return {
    ...rp,
    ...params,
    dtNs: params.dtNs ?? params.dt ?? rp.dtNs,
    dxM: params.dxM ?? params.dx ?? rp.dxM,
    dt: params.dt ?? params.dtNs ?? rp.dtNs,
    dx: params.dx ?? params.dxM ?? rp.dxM,
    velocity: params.velocity ?? params.velocityMPerNs ?? rp.velocityMPerNs,
    vofh: params.vofh ?? params.vofhText ?? rp.vofhText,
    dzM: params.dzM ?? params.dz ?? rp.depthDzM,
    zMaxM: params.zMaxM ?? params.zMax ?? rp.depthMaxM,
    antennaFreqMHz: params.antennaFreqMHz ?? rp.antennaFreqMHz,
    q: params.q ?? rp.q
  };
}

function datasetDtNs(ds) {
  return getEffectiveRadarParams(ds).dtNs;
}

function datasetDxM(ds) {
  return getEffectiveRadarParams(ds).dxM;
}

function firstFiniteAxisValue(axis) {
  if (!axis?.length) return NaN;
  for (let i = axis.length - 1; i >= 0; i--) {
    const value = Number(axis[i]);
    if (Number.isFinite(value)) return value;
  }
  return NaN;
}

function velocityFromGeoControl() {
  const inputVelocity = finiteNumber($("#geo-velocity")?.value, NaN);
  if (Number.isFinite(inputVelocity)) return inputVelocity;
  return getEffectiveRadarParams(currentDisplayed()).velocityMPerNs;
}

function inferredDepthMax(ds, dtNs = datasetDtNs(ds), velocity = velocityFromGeoControl()) {
  if (!ds) return 0;
  const axisDepth = firstFiniteAxisValue(ds.depthAxisM || ds.meta?.depthAxisM);
  if (Number.isFinite(axisDepth) && axisDepth > 0) return axisDepth;
  const depthStep = finiteNumber(ds.depthStep ?? ds.meta?.depthStep, NaN);
  if (Number.isFinite(depthStep)) return Math.max(0, ds.numSamples - 1) * depthStep;
  return getEffectiveRadarParams(ds, { dtNs, velocity }).depthMaxM;
}

function formatDepthInput(value) {
  if (!Number.isFinite(value)) return "";
  return value >= 20 ? value.toFixed(1) : value.toFixed(2);
}

function updateGeoDepthFromControls(force = false) {
  const ds = currentDisplayed();
  const depthEl = $("#geo-depth");
  if (!ds || !depthEl) return;
  if (!force && depthEl.dataset.manual === "true") return;
  const dtNs = finiteNumber($("#geo-dt")?.value, datasetDtNs(ds));
  const velocity = velocityFromGeoControl();
  depthEl.value = formatDepthInput(inferredDepthMax(ds, dtNs, velocity));
  depthEl.dataset.manual = "false";
}

function syncGeoControlsFromDataset(force = false) {
  const ds = currentDisplayed();
  if (!ds) return;
  const rp = getEffectiveRadarParams(ds);
  const key = [ds.id || ds.name || "", ds.numTraces, ds.numSamples, rp.dtNs, rp.dxM, rp.velocityMPerNs, rp.depthMaxM].join("|");
  if (!force && key === lastGeoDatasetKey) return;
  const dtEl = $("#geo-dt"), dxEl = $("#geo-dx"), velEl = $("#geo-velocity"), depthEl = $("#geo-depth");
  if (dtEl) dtEl.value = rp.dtNs.toFixed(4);
  if (dxEl) dxEl.value = rp.dxM.toFixed(4);
  if (velEl) velEl.value = rp.velocityMPerNs.toFixed(3);
  if ($("#geo-lo")) $("#geo-lo").value = rp.freqLowMHz;
  if ($("#geo-hi")) $("#geo-hi").value = rp.freqHighMHz;
  if (depthEl) depthEl.dataset.manual = "false";
  currentVofhText = rp.vofhText;
  lastGeoDatasetKey = key;
  updateGeoDepthFromControls(true);
}

function fallbackDepthAxis(ds) {
  if (!ds) return null;
  const axis = ds.depthAxisM || ds.meta?.depthAxisM;
  if (axis?.length) return axis;
  const step = ds.depthStep || ds.meta?.depthStep;
  if (Number.isFinite(step) && step > 0) {
    const out = new Float32Array(ds.numSamples);
    for (let i = 0; i < out.length; i++) out[i] = i * step;
    return out;
  }
  const rp = getEffectiveRadarParams(ds);
  return depthAxisFromVofh(ds.numSamples, rp.dtNs, rp.vofhText || `${rp.velocityMPerNs},0`);
}

function applyDepthAxisMode() {
  const ds = currentDisplayed();
  radar.setVerticalAxisMode(depthAxisEnabled ? "depth" : "sample", depthAxisEnabled ? fallbackDepthAxis(ds) : null);
  $("#depth-axis-toggle")?.classList.toggle("active", depthAxisEnabled);
}

function fileExt(name) {
  const match = String(name || "").toLowerCase().match(/\.[^.]+$/);
  return match ? match[0] : "";
}

function fileStem(name) {
  return String(name || "").replace(/\.[^.]+$/i, "").toLowerCase();
}

function finishImport(parsed, file) {
  const enriched = buildRadarMetadata({ ...parsed, name: file.name, fileSize: file.size, loadedAt: new Date().toLocaleString("zh-CN") });
  store.loadDataset(enriched);
  if (parsed.meta?.sourceFormat === ".HCD") {
    $("#amp-min").value = parsed.meta.displayAmpMin ?? HCD_DEFAULT_AMP.min;
    $("#amp-max").value = parsed.meta.displayAmpMax ?? HCD_DEFAULT_AMP.max;
    radar.setAmp(Number($("#amp-min").value), Number($("#amp-max").value));
  }
  clearInteractionState();
  toast(`${file.name} 导入成功`);
  $("#footer-status").textContent = "导入完成";
  switchPage("radar");
}

async function read2BImport(file) {
  $("#footer-status").textContent = `正在解析 ${file.name}`;
  finishImport(parse2BFile(await file.arrayBuffer()), file);
}

async function readHcdImport(hcdFile, hadFile = null) {
  $("#footer-status").textContent = `正在解析 ${hcdFile.name}`;
  if (!hadFile) throw new Error("HCD 导入需要同时选择同名 .had 文件");
  const params = parseHadText(await hadFile.text());
  finishImport(parseHcdFile(await hcdFile.arrayBuffer(), params), hcdFile);
}

async function importFiles(files) {
  const list = Array.from(files || []);
  const groups = new Map();
  for (const file of list) {
    const ext = fileExt(file.name);
    if (![".2b", ".hcd", ".had"].includes(ext)) {
      toast(`${file.name} 暂不支持导入`, "warn");
      continue;
    }
    const stem = fileStem(file.name);
    const group = groups.get(stem) || {};
    if (ext === ".2b") group.twoB = file;
    else if (ext === ".hcd") group.hcd = file;
    else if (ext === ".had") group.had = file;
    groups.set(stem, group);
  }
  for (const group of groups.values()) {
    try {
      if (group.twoB) await read2BImport(group.twoB);
      if (group.hcd) await readHcdImport(group.hcd, group.had || null);
      else if (group.had) toast(`${group.had.name}: 请同时选择同名 .hcd 文件`, "warn");
    } catch (error) {
      const name = group.twoB?.name || group.hcd?.name || group.had?.name || "data";
      toast(`${name}: ${error.message}`, "err");
      $("#footer-status").textContent = "导入失败";
    }
  }
}

const processDefs = {
  "signal-position": ["调整信号位置", [{ id: "shift", label: "裁剪零点前样点数", value: 0 }]],
  "trim-time": ["定时窗口", [{ id: "start", label: "起始样点", value: 0 }, { id: "end", label: "结束样点", value: 1023 }]],
  "bad-traces": ["不良道插值替换", [{ id: "ranges", label: "坏道范围，例如 5-9,22", value: "" }]],
  "remove-dc": ["去均值 Remove DC", []],
  "dewow": ["去低频 Dewow", []],
  "dzt-gain": ["Remove DZT header gain 去除 DZT 头增益", [{ id: "gain", label: "Gain points (dB, comma-separated) 增益点", value: "0,2,4,6,8,10" }]],
  "equalize": ["均衡轨迹", []],
  "resample-time": ["重采样时间轴", [{ id: "samples", label: "新样点数", value: 2048 }, { id: "dtNs", label: "当前 dt (ns)", value: 0.625 }, { id: "order", label: "sinc 半阶", value: 15 }]],
  "resample-scan": ["重采样扫描轴", [{ id: "traces", label: "新道数", value: 512 }, { id: "dxM", label: "当前 dx (m)", value: 0.05 }, { id: "order", label: "sinc 半阶", value: 15 }]],
  "equal-spacing": ["转换为等间距", [{ id: "traces", label: "等间距道数", value: 512 }, { id: "dxM", label: "当前 dx (m)", value: 0.05 }, { id: "order", label: "sinc 半阶", value: 15 }]],
  agc: ["Standard AGC 标准 AGC", [{ id: "windowNs", label: "AGC 窗口 (ns)", value: 31.25 }, { id: "dtNs", label: "dt (ns)", value: 0.625 }]],
  gagc: ["Gaussian-tapered AGC 高斯窗 AGC", [{ id: "windowNs", label: "AGC 窗口 (ns)", value: 31.25 }, { id: "dtNs", label: "dt (ns)", value: 0.625 }, { id: "eps", label: "EPS", value: 5e-7 }]],
  "power-gain": ["Inverse Power Decay 反幂衰减增益", [{ id: "power", label: "幂次 auto 或数字", value: "auto" }, { id: "dtNs", label: "dt (ns)", value: 0.625 }]],
  "amplitude-gain": ["Inverse Amplitude Decay 反振幅衰减增益", [{ id: "curve", label: "衰减曲线 median/mean", value: "median" }, { id: "order", label: "多指数阶数", value: 3 }, { id: "dtNs", label: "dt (ns)", value: 0.625 }]],
  "global-bg": ["Remove Global Background 去全局背景", []],
  horizontal: ["Suppress Horizontal Features 压制水平同相轴", [{ id: "width", label: "滑动窗口道数", value: 25 }]],
  dipping: ["Suppress Dipping Features 压制倾斜同相轴", [{ id: "width", label: "滑动窗口道数", value: 25 }]],
  "fir-frequency": ["FIR Frequency Filter FIR 频率滤波", [{ id: "type", label: "类型 bp/lp/hp/bs", value: "bp" }, { id: "lo", label: "低频 MHz", value: 20 }, { id: "hi", label: "高频 MHz", value: 200 }, { id: "dtNs", label: "dt (ns)", value: 0.625 }]],
  "fir-wavenumber": ["FIR Wavenumber Filter FIR 波数滤波", [{ id: "type", label: "类型 bp/lp/hp/bs", value: "bp" }, { id: "loK", label: "低波数 m^-1", value: 0.2 }, { id: "hiK", label: "高波数 m^-1", value: 5 }, { id: "dxM", label: "dx (m)", value: 0.05 }]],
  "fk-filter": ["F-K Filter 频率-波数滤波", []],
  "kl-filter": ["Karhunen-Loeve Filter K-L 主成分滤波", [{ id: "components", label: "主成分个数 P", value: 9 }, { id: "output", label: "输出 model/residual", value: "model" }]],
  "fx-decon": ["F-X Deconvolution F-X 反褶积", [{ id: "operatorLength", label: "预测算子长度", value: 8 }, { id: "muPercent", label: "预白化 (%)", value: 1 }, { id: "flowMHz", label: "低频 MHz", value: 20 }, { id: "fhighMHz", label: "高频 MHz", value: 600 }]],
  "sparse-decon": ["Sparse Deconvolution 稀疏反褶积", [{ id: "frequencyMHz", label: "Ricker 主频 MHz", value: 100 }, { id: "lengthSamples", label: "子波长度样点", value: 64 }, { id: "mu", label: "L1 正则 mu", value: 0.01 }, { id: "iterations", label: "IRLS 迭代", value: 10 }, { id: "output", label: "输出 reflectivity/predicted", value: "reflectivity" }]],
  "attenuation-analysis": ["Attenuation Analysis 衰减分析", []],
  "mean-median-filter": ["Mean/Median Filter 均值/中值滤波", [{ id: "mode", label: "Mode mean/median 模式", value: "mean" }, { id: "vSize", label: "垂直窗口(样点)", value: 3 }, { id: "hSize", label: "水平窗口(道)", value: 3 }]],
  "notch-filter": ["Notch Filter 陷波滤波", [{ id: "frequencyMHz", label: "陷波频率 MHz", value: 50 }, { id: "dtNs", label: "dt (ns)", value: 0.625 }]],
  predc: ["Predictive Deconvolution 预测反褶积", [{ id: "operatorLength", label: "预测算子长度(样点)", value: 32 }, { id: "predictionLength", label: "预测距离(样点)", value: 1 }, { id: "muPercent", label: "预白化 (%)", value: 5 }]],
  "static-correction": ["Static Corrections 静校正", [{ id: "elevation", label: "高程值(逗号分隔)", value: "0" }, { id: "swv", label: "表层速度 m/ns", value: .1 }, { id: "wv", label: "次表层速度 m/ns", value: .1 }]],
  "advanced-placeholder": ["Tau-P / Curvelet / FDTD τ-p/曲波/正演", []],
  instantaneous: ["瞬时属性", [{ id: "attr", label: "属性 amplitude/atan/atan2/unwrapped/ifreq", value: "amplitude" }, { id: "dtNs", label: "dt (ns)", value: 0.625 }]],
  stolt: ["1-D F-K / Stolt Migration Stolt 偏移", [{ id: "vofh", label: "层状速度模型: 速度,厚度", value: "0.1,0", type: "textarea" }, { id: "dtNs", label: "dt ns", value: .625 }, { id: "dxM", label: "dx m", value: .05 }]],
  gazdag: ["1-D Phase-shift / Gazdag 相移偏移", [{ id: "vofh", label: "层状速度模型: 速度,厚度", value: "0.1,0", type: "textarea" }, { id: "dtNs", label: "dt ns", value: .625 }, { id: "dxM", label: "dx m", value: .05 }]],
  "time-depth": ["Time-to-Depth Conversion 时深转换", [{ id: "vofh", label: "层状速度模型: 速度,厚度", value: "0.1,0", type: "textarea" }, { id: "dtNs", label: "dt ns", value: .625 }, { id: "dzM", label: "深度采样 m", value: .02 }]],
  pspi: ["2-D PSPI Migration PSPI 偏移", [{ id: "velocity", label: "参考速度 m/ns", value: .1 }, { id: "dt", label: "dt ns", value: .625 }, { id: "dx", label: "dx m", value: .05 }, { id: "dzM", label: "深度步长 m", value: .02 }, { id: "zMaxM", label: "最大深度 m (可空)", value: "" }]],
  "split-step": ["2-D Split-step Fourier 分步傅里叶偏移", [{ id: "vofh", label: "层状速度模型: 速度,厚度", value: "0.1,0", type: "textarea" }, { id: "dtNs", label: "dt ns", value: .625 }, { id: "dxM", label: "dx m", value: .05 }, { id: "dzM", label: "深度步长 m", value: .02 }, { id: "zMaxM", label: "最大深度 m (可空)", value: "" }, { id: "fMaxGHz", label: "最高频率 GHz (可空)", value: "" }, { id: "q", label: "Q (可空)", value: "" }, { id: "antennaFreqMHz", label: "天线频率 MHz (可空)", value: "" }]]
};

function openProcess(op) {
  if (!store.current) return toast("请先导入数据", "warn");
  if (op === "fk-filter") return openFkDesigner();
  const [title, fields] = processDefs[op] || [op, []];
  const fieldValue = f => {
    const ds = store.current;
    const rp = getEffectiveRadarParams(ds);
    if (f.id === "vofh") return rp.vofhText || currentVofhText || f.value;
    if (f.id === "dtNs" || f.id === "dt") return rp.dtNs;
    if (f.id === "dxM" || f.id === "dx") return rp.dxM;
    if (f.id === "velocity") return rp.velocityMPerNs;
    if (f.id === "dzM") return rp.depthDzM;
    if (f.id === "zMaxM") return rp.depthMaxM;
    if (f.id === "antennaFreqMHz") return Number.isFinite(rp.antennaFreqMHz) ? rp.antennaFreqMHz : f.value;
    if (f.id === "q") return rp.q || f.value;
    if (["lo", "flowMHz"].includes(f.id)) return rp.freqLowMHz;
    if (["hi", "fhighMHz"].includes(f.id)) return rp.freqHighMHz;
    if (f.id === "samples") return ds.numSamples;
    if (f.id === "traces") return ds.numTraces;
    if (f.id === "end") return ds.numSamples - 1;
    return f.value;
  };
  const fieldHtml = f => {
    const value = fieldValue(f);
    if (f.type === "textarea") return `<label>${f.label}<textarea data-field="${f.id}" rows="4">${value}</textarea></label>`;
    return `<label>${f.label}<input data-field="${f.id}" value="${value}"></label>`;
  };
  $("#process-title").textContent = title;
  $("#process-fields").innerHTML = fields.length ? fields.map(fieldHtml).join("") : `<p class="muted">无需额外参数。执行后生成 Output Data，需要 Hold 才会成为 Current Input Data。</p>`;
  $("#run-process").onclick = async ev => {
    ev.preventDefault();
    try {
      const params = {};
      $$("[data-field]").forEach(i => {
        const key = i.dataset.field;
        const raw = i.value.trim();
        params[key] = raw === "" || isNaN(Number(raw)) || ["type", "ranges", "curve", "attr", "power", "output", "vofh", "gain"].includes(key) ? raw : Number(raw);
      });
      if (params.vofh) currentVofhText = params.vofh;
      $("#process-dialog").close();
      $("#footer-status").textContent = `正在执行 ${title}`;
      if (op === "advanced-placeholder") return toast("该功能入口已新增，算法将在下一阶段接入。", "warn");
      const result = await runWorker(op, store.current, params);
      store.setOutput({ ...result, name: `${store.current.name}_${op}` }, { name: title, op, params });
      displaySource = "output"; $("#display-mode").value = "output";
      $("#footer-status").textContent = "Output Data 已生成，等待 Hold/Discard";
      toast(`${title} 完成，请验收 Output Data`);
    } catch (error) {
      toast(error.message, "err");
      $("#footer-status").textContent = "处理失败";
    }
  };
  $("#process-dialog").showModal();
}

function ensureAlgorithmDialog() {
  let dlg = $("#algorithm-help-dialog");
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.id = "algorithm-help-dialog";
  dlg.className = "wide-dialog algorithm-dialog";
  dlg.innerHTML = `
    <form method="dialog">
      <h2>算法说明</h2>
      <p class="muted">以下列表不包含基础滤波、去直流、去低频等预处理；每个算法执行后先进入 Output Data。</p>
      <div id="algorithm-help-list" class="algorithm-help-list"></div>
      <menu><button value="cancel">关闭</button></menu>
    </form>`;
  document.body.appendChild(dlg);
  return dlg;
}

function showAlgorithmHelp() {
  const dlg = ensureAlgorithmDialog();
  $("#algorithm-help-list").innerHTML = algorithmDocs.map(([name, principle, usage], i) => `
    <article class="algorithm-card">
      <h3>${i + 1}. ${escapeHtml(name)}</h3>
      <p><b>原理：</b>${escapeHtml(principle)}</p>
      <p><b>用法：</b>${escapeHtml(usage)}</p>
    </article>`).join("");
  dlg.showModal();
}

const radarParamFields = [
  ["dtNs", "dt ns 采样间隔"],
  ["dxM", "dx m 道间距"],
  ["velocityMPerNs", "velocity m/ns 介质速度"],
  ["epsilonR", "epsilon_r 相对介电常数"],
  ["antennaFreqMHz", "antenna MHz 天线频率"],
  ["freqLowMHz", "low MHz 默认低频"],
  ["freqHighMHz", "high MHz 默认高频"],
  ["q", "Q 可空"],
  ["timeZeroSample", "time zero sample 时间零点"],
  ["depthDzM", "depth dz m 深度步长"],
  ["depthMaxM", "depth max m 最大深度"]
];

function ensureRadarParamsDialog() {
  let dlg = $("#radar-params-dialog");
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.id = "radar-params-dialog";
  dlg.className = "wide-dialog radar-params-dialog";
  dlg.innerHTML = `
    <form method="dialog">
      <h2>Radar Parameters 雷达参数</h2>
      <p class="muted">文件头只作为建议值；保存后参数跟随当前数据集，并用于深度轴、偏移、滤波、地质建模和导出。</p>
      <div class="radar-param-grid" id="radar-param-fields"></div>
      <label>vofhText 层状速度模型<textarea id="radar-param-vofh" rows="4"></textarea></label>
      <h3>Header Suggestions 文件头建议</h3>
      <div id="radar-param-suggestions" class="list muted"></div>
      <menu>
        <button value="cancel">取消</button>
        <button id="radar-param-save" value="default" class="primary">保存到当前数据集</button>
      </menu>
    </form>`;
  document.body.appendChild(dlg);
  return dlg;
}

function formatSuggestionValue(value) {
  if (value == null || value === "") return "无";
  if (typeof value === "number") return Number.isFinite(value) ? value.toFixed(Math.abs(value) >= 10 ? 3 : 5).replace(/\.?0+$/, "") : "无";
  return String(value);
}

function openRadarParamsDialog() {
  const ds = store.current;
  if (!ds) return toast("请先导入数据", "warn");
  const dlg = ensureRadarParamsDialog();
  const rp = getEffectiveRadarParams(ds);
  const hs = ds.meta?.headerSuggestions || {};
  $("#radar-param-fields").innerHTML = radarParamFields.map(([id, label]) => {
    const value = rp[id] ?? "";
    const text = value === "" || !Number.isFinite(Number(value)) ? "" : Number(value).toString();
    return `<label>${label}<input data-radar-param="${id}" value="${text}"></label>`;
  }).join("");
  $("#radar-param-vofh").value = rp.vofhText || `${rp.velocityMPerNs},0`;
  $("#radar-param-suggestions").innerHTML = Object.entries(hs).map(([k, v]) => `<div><span>${escapeHtml(k)}</span><b>${escapeHtml(formatSuggestionValue(v))}</b></div>`).join("") || "暂无文件头建议";
  dlg.onclose = () => {
    if (dlg.returnValue !== "default") return;
    const values = {};
    $$("[data-radar-param]").forEach(input => {
      const key = input.dataset.radarParam;
      values[key] = input.value.trim() === "" ? "" : Number(input.value);
    });
    const velocity = finiteNumber(values.velocityMPerNs, velocityFromEps(values.epsilonR, 0.1));
    const radarParams = {
      ...rp,
      ...values,
      dtNs: finiteNumber(values.dtNs, rp.dtNs),
      dxM: finiteNumber(values.dxM, rp.dxM),
      velocityMPerNs: velocity,
      epsilonR: finiteNumber(values.epsilonR, epsFromVelocity(velocity)),
      vofhText: $("#radar-param-vofh").value.trim() || `${velocity},0`,
      antennaFreqMHz: Number.isFinite(Number(values.antennaFreqMHz)) ? Number(values.antennaFreqMHz) : "",
      q: values.q === "" || values.q == null ? "" : (Number.isFinite(Number(values.q)) ? Number(values.q) : ""),
      timeZeroSample: Number.isFinite(Number(values.timeZeroSample)) ? Number(values.timeZeroSample) : 0,
      depthDzM: finiteNumber(values.depthDzM, rp.depthDzM),
      depthMaxM: finiteNumber(values.depthMaxM, rp.depthMaxM)
    };
    const updated = buildRadarMetadata({ ...ds, meta: { ...(ds.meta || {}), radarParams } });
    currentVofhText = updated.meta.radarParams.vofhText;
    store.updateCurrentMeta(updated.meta);
    syncGeoControlsFromDataset(true);
    syncExportControls();
    applyDepthAxisMode();
    toast("雷达参数已保存到当前数据集");
  };
  dlg.showModal();
}

function ensureFkDialog() {
  let dlg = $("#fk-dialog");
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.id = "fk-dialog";
  dlg.className = "wide-dialog";
  dlg.innerHTML = `
    <form method="dialog">
      <h2>F-K Filter Designer</h2>
      <div class="fk-layout">
        <div class="fk-canvas-wrap"><canvas id="fk-canvas"></canvas></div>
        <div class="fk-controls">
          <label>dt (ns)<input id="fk-dt" type="number" step="0.0001"></label>
          <label>dx (m)<input id="fk-dx" type="number" step="0.001"></label>
          <label>模式
            <select id="fk-mode">
              <option value="polygon">Polygon zone</option>
              <option value="velocity-fan">Velocity fan</option>
              <option value="up-dip">Up-dip</option>
              <option value="down-dip">Down-dip</option>
            </select>
          </label>
          <label>动作
            <select id="fk-action">
              <option value="pass">Pass</option>
              <option value="stop">Stop</option>
            </select>
          </label>
          <label>速度下限 (m/ns)<input id="fk-vmin" type="number" value="0.03" step="0.005"></label>
          <label>速度上限 (m/ns)<input id="fk-vmax" type="number" value="0.30" step="0.005"></label>
          <div id="fk-readout" class="muted">点击谱图添加多边形顶点，拖动顶点可调整。</div>
          <div class="button-row">
            <button id="fk-clear" value="cancel" type="button">清空多边形</button>
            <button id="fk-apply" value="default" class="primary" type="button">Apply to Output</button>
          </div>
        </div>
      </div>
      <menu>
        <button value="cancel">关闭</button>
      </menu>
    </form>`;
  document.body.appendChild(dlg);
  return dlg;
}

function openFkDesigner() {
  const ds = store.current;
  if (!ds) return toast("请先导入数据", "warn");
  const dlg = ensureFkDialog();
  const cv = $("#fk-canvas");
  const rp = getEffectiveRadarParams(ds);
  const dt = rp.dtNs;
  const dx = rp.dxM;
  $("#fk-dt").value = dt;
  $("#fk-dx").value = dx;
  let spec = null;
  let points = [];
  let drag = -1;
  const canvasPoint = e => {
    const r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toPhysical = p => {
    const w = cv.clientWidth || 1, h = cv.clientHeight || 1;
    return {
      k: (p.x / w * 2 - 1) * spec.kMax,
      f: (1 - p.y / h) * spec.fMaxGHz
    };
  };
  const toCanvas = p => {
    const w = cv.clientWidth || 1, h = cv.clientHeight || 1;
    return {
      x: (p.k / spec.kMax + 1) * 0.5 * w,
      y: (1 - p.f / spec.fMaxGHz) * h
    };
  };
  const nearestPoint = p => {
    let best = -1, bd = 14;
    points.forEach((pt, i) => {
      const q = toCanvas(pt), d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };
  const draw = () => {
    const rect = cv.parentElement.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(rect.width)), h = Math.max(1, Math.floor(rect.height));
    cv.width = w * dpr; cv.height = h * dpr; cv.style.width = `${w}px`; cv.style.height = `${h}px`;
    const ctx = cv.getContext("2d"); ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.fillStyle = "#080c14"; ctx.fillRect(0,0,w,h);
    if (spec) {
      const img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const sx = Math.min(spec.width - 1, Math.floor(x / w * spec.width));
        const sy = Math.min(spec.height - 1, Math.floor(spec.height / 2 + (1 - y / h) * (spec.height / 2 - 1)));
        const v = Math.max(0, Math.min(255, Math.round((spec.values[sy * spec.width + sx] || 0) * 255)));
        const i = (y * w + x) * 4;
        img.data[i] = v; img.data[i + 1] = Math.min(255, v + 25); img.data[i + 2] = 255 - Math.floor(v * 0.4); img.data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    }
    ctx.strokeStyle = "rgba(255,255,255,.45)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.moveTo(0, h - 1); ctx.lineTo(w, h - 1); ctx.stroke();
    if (!spec) return;
    const mode = $("#fk-mode").value;
    if (mode === "polygon" && points.length) {
      ctx.strokeStyle = "#fff200"; ctx.fillStyle = "rgba(255,242,0,.12)"; ctx.lineWidth = 2;
      ctx.beginPath();
      points.forEach((pt, i) => {
        const q = toCanvas(pt);
        i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y);
      });
      if (points.length >= 3) ctx.closePath();
      ctx.fill(); ctx.stroke();
      for (const pt of points) {
        const q = toCanvas(pt);
        ctx.beginPath(); ctx.arc(q.x, q.y, 5, 0, Math.PI * 2); ctx.fillStyle = "#fff200"; ctx.fill();
      }
    } else if (mode === "velocity-fan") {
      const vmin = Number($("#fk-vmin").value || 0.03), vmax = Number($("#fk-vmax").value || 0.3);
      ctx.strokeStyle = "#fff200"; ctx.lineWidth = 2;
      for (const v of [vmin, vmax, -vmin, -vmax]) {
        const kEdge = Math.sign(v) * Math.min(spec?.kMax || 1, (spec?.fMaxGHz || 1) / Math.abs(v));
        const a = toCanvas({ k: 0, f: 0 }), b = toCanvas({ k: kEdge, f: Math.abs(kEdge * v) });
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    } else if (mode === "up-dip" || mode === "down-dip") {
      ctx.strokeStyle = "#fff200"; ctx.lineWidth = 2;
      ctx.beginPath();
      if (mode === "up-dip") { ctx.moveTo(0, 0); ctx.lineTo(w, h); }
      else { ctx.moveTo(w, 0); ctx.lineTo(0, h); }
      ctx.stroke();
    }
  };
  const redraw = () => requestAnimationFrame(draw);
  cv.onmousedown = e => {
    if (!spec || $("#fk-mode").value !== "polygon") return;
    const p = canvasPoint(e);
    drag = nearestPoint(p);
    if (drag < 0) { points.push(toPhysical(p)); drag = points.length - 1; }
    addEventListener("mouseup", () => { drag = -1; }, { once: true });
    redraw();
  };
  cv.onmousemove = e => {
    if (!spec) return;
    const p = canvasPoint(e), phys = toPhysical(p);
    $("#fk-readout").textContent = `k=${phys.k.toFixed(3)} m^-1 · f=${phys.f.toFixed(3)} GHz · ${points.length} vertices`;
    if (drag >= 0) { points[drag] = toPhysical(p); redraw(); }
  };
  cv.oncontextmenu = e => {
    e.preventDefault();
    const i = nearestPoint(canvasPoint(e));
    if (i >= 0) points.splice(i, 1);
    redraw();
  };
  $("#fk-clear").onclick = () => { points = []; redraw(); };
  ["fk-mode","fk-action","fk-vmin","fk-vmax"].forEach(id => $(`#${id}`).oninput = redraw);
  $("#fk-apply").onclick = async () => {
    try {
      const params = {
        dtNs: Number($("#fk-dt").value || dt),
        dxM: Number($("#fk-dx").value || dx),
        mode: $("#fk-mode").value,
        action: $("#fk-action").value,
        polygon: points,
        velocityRange: { min: Number($("#fk-vmin").value || 0.03), max: Number($("#fk-vmax").value || 0.3) }
      };
      if (params.mode === "polygon" && params.polygon.length < 3) return toast("多边形模式至少需要 3 个顶点", "warn");
      dlg.close();
      $("#footer-status").textContent = "正在执行 F-K Filter";
      const result = await runWorker("fk-filter", store.current, params);
      store.setOutput({ ...result, name: `${store.current.name}_fk-filter` }, { name: "F-K Filter", op: "fk-filter", params });
      displaySource = "output"; $("#display-mode").value = "output";
      $("#footer-status").textContent = "Output Data 已生成，等待 Hold/Discard";
      toast("F-K Filter 完成，请验收 Output Data");
    } catch (error) {
      toast(error.message, "err");
      $("#footer-status").textContent = "F-K Filter 失败";
    }
  };
  dlg.showModal();
  $("#footer-status").textContent = "正在计算 F-K 谱图";
  setTimeout(() => {
    try {
      spec = fkSpectrum(ds.data, ds.numTraces, ds.numSamples, Number($("#fk-dt").value || dt), Number($("#fk-dx").value || dx), 256);
      $("#footer-status").textContent = "F-K 设计器就绪";
      draw();
    } catch (error) {
      toast(error.message, "err");
      $("#footer-status").textContent = "F-K 谱图计算失败";
    }
  });
}

function switchPage(name) {
  $$(".page").forEach(p => p.classList.remove("active"));
  $(`#page-${name}`)?.classList.add("active");
  if (name === "data-manager") renderDataManager();
  if (name === "export") syncExportControls();
  if (name === "velocity") renderVelocity();
  if (name === "model") renderModel();
  if (name === "three") renderThree();
  if (name === "interpret" || name === "geo-modeling" || name === "manual-geo") {
    syncGeoControlsFromDataset();
    drawGeologyResult();
    if (name === "geo-modeling") drawManualGeoResult();
    if (name === "manual-geo") { ensureManualState(); drawManualWorkbench(); }
  }
}

function openFloat(id) {
  const el = $(`#${id}`);
  el.classList.add("show");
  if (id === "trace-window") drawTrace();
  if (id === "spectrum-window") drawSpectrum();
}
function syncTraceIndex(t, redraw = true) {
  $("#trace-index").value = t; $("#spectrum-index").value = t; radar.setCurrentTrace(t);
  if (redraw) { drawTrace(); drawSpectrum(); }
}
function moveTrace(delta) {
  const ds = currentDisplayed(); if (!ds) return;
  syncTraceIndex(Math.max(0, Math.min(ds.numTraces - 1, Number($("#trace-index").value || 0) + delta)));
}
function drawTrace() {
  const ds = currentDisplayed(); if (!ds) return;
  const t = Math.max(0, Math.min(ds.numTraces - 1, Number($("#trace-index").value || 0)));
  const tr = ds.data.subarray(t * ds.numSamples, t * ds.numSamples + ds.numSamples);
  let rms = 0; for (const v of tr) rms += v * v; rms = Math.sqrt(rms / tr.length);
  $("#trace-stats").textContent = `RMS ${rms.toFixed(4)} · Max ${Math.max(...tr).toFixed(4)} · Min ${Math.min(...tr).toFixed(4)}`;
  drawLine($("#trace-canvas"), [...tr], { title: `Trace ${t}` });
  radar.setCurrentTrace(t);
}
function drawSpectrum(mean = false) {
  const ds = currentDisplayed(); if (!ds) return;
  const t = Math.max(0, Math.min(ds.numTraces - 1, Number($("#spectrum-index").value || 0)));
  let sp;
  if (mean) {
    const avg = new Float32Array(ds.numSamples);
    for (let i = 0; i < ds.numTraces; i++) for (let s = 0; s < ds.numSamples; s++) avg[s] += ds.data[i * ds.numSamples + s] / ds.numTraces;
    sp = spectrum(avg);
  } else sp = spectrum(ds.data.subarray(t * ds.numSamples, t * ds.numSamples + ds.numSamples));
  let peak = 0, pi = 0; sp.forEach((v, i) => { if (v > peak) { peak = v; pi = i; } });
  $("#spectrum-stats").textContent = `Peak bin ${pi} · ${peak.toExponential(2)}`;
  drawLine($("#spectrum-canvas"), [...sp], { title: mean ? "Mean Trace Spectrum" : `Trace ${t} Spectrum`, color: "#00b42a" });
  radar.setCurrentTrace(t);
}

function renderVelocity() {
  const ds = currentDisplayed(), cv = $("#velocity-canvas");
  if (!ds) return;
  const rp = getEffectiveRadarParams(ds);
  if ($("#vel-dt")) $("#vel-dt").value = rp.dtNs.toFixed(4);
  if ($("#vel-dx")) $("#vel-dx").value = rp.dxM.toFixed(4);
  if ($("#vel-v")) $("#vel-v").value = rp.velocityMPerNs.toFixed(3);
  if (!velocityRenderer || velocityRenderer.canvas !== cv) velocityRenderer = new RadarRenderer(cv, cv.parentElement);
  const rr = velocityRenderer;
  rr.setDataset(ds);
  let redrawFrame = 0;
  const currentParams = point => ({
    v: Number($("#vel-v").value),
    x0: point?.x0 ?? Number($("#vel-x0").value),
    z0: point?.z0 ?? Number($("#vel-z0").value),
    dx: Number($("#vel-dx").value),
    dt: Number($("#vel-dt").value)
  });
  const drawHyperbola = (point, opts = {}) => {
    if (!point || !rr.view) return;
    const p = rr.plot(), ctx = rr.ctx, params = currentParams(point);
    const alpha = 2 * params.dx / Math.max(params.v * params.dt, 1e-9);
    const color = opts.color || "#fff200";
    const startT = Math.max(0, Math.floor(rr.view.t0));
    const endT = Math.min(ds.numTraces - 1, Math.ceil(rr.view.t1));
    const strokePath = () => {
      ctx.beginPath();
      let started = false;
      for (let t = startT; t <= endT; t++) {
        const s = Math.sqrt(params.z0 * params.z0 + alpha * alpha * (t - params.x0) ** 2);
        if (s < rr.view.s0 || s > rr.view.s1 || s < 0 || s >= ds.numSamples) continue;
        const x = p.x + (t - rr.view.t0) / (rr.view.t1 - rr.view.t0) * p.w;
        const y = p.y + (s - rr.view.s0) / (rr.view.s1 - rr.view.s0) * p.h;
        started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        started = true;
      }
      if (started) ctx.stroke();
    };
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.setLineDash(opts.dashed ? [8, 5] : []);
    ctx.strokeStyle = "rgba(2,8,18,.9)";
    ctx.lineWidth = (opts.width || 3) + 3;
    strokePath();
    ctx.shadowColor = color;
    ctx.shadowBlur = opts.glow ?? 12;
    ctx.strokeStyle = color;
    ctx.lineWidth = opts.width || 3;
    strokePath();
    ctx.restore();
  };
  const redraw = () => {
    rr.render();
    const inputPoint = { x0: Number($("#vel-x0").value), z0: Number($("#vel-z0").value) };
    if (velocityFixedPoint) drawHyperbola(velocityFixedPoint, { color: "#fff200", width: 3.4, glow: 14 });
    if (velocityPreviewPoint) drawHyperbola(velocityPreviewPoint, { color: "#00f5ff", width: 2.8, glow: 10, dashed: true });
    if (!velocityFixedPoint && !velocityPreviewPoint) drawHyperbola(inputPoint, { color: "#fff200", width: 3.2, glow: 12 });
  };
  const scheduleRedraw = () => {
    cancelAnimationFrame(redrawFrame);
    redrawFrame = requestAnimationFrame(redraw);
  };
  cv.onmousemove = e => {
    const r = cv.getBoundingClientRect(), d = rr.dataAt(e.clientX - r.left, e.clientY - r.top);
    if (!d) return;
    velocityPreviewPoint = { x0: d.t, z0: d.s };
    scheduleRedraw();
  };
  cv.onmouseleave = () => { velocityPreviewPoint = null; scheduleRedraw(); };
  cv.onclick = e => {
    const r = cv.getBoundingClientRect(), d = rr.dataAt(e.clientX - r.left, e.clientY - r.top);
    if (d) {
      velocityFixedPoint = { x0: d.t, z0: d.s };
      velocityPreviewPoint = null;
      $("#vel-x0").value = d.t;
      $("#vel-z0").value = d.s;
      redraw();
    }
  };
  cv.__velocityWheelRedraw = redraw;
  if (!cv.__velocityWheelBound) {
    cv.addEventListener("wheel", e => {
      e.preventDefault();
      e.stopImmediatePropagation();
      $("#vel-v").value = Math.max(.03, Math.min(.3, Number($("#vel-v").value) + (e.deltaY > 0 ? -.002 : .002))).toFixed(3);
      cv.__velocityWheelRedraw?.();
    }, { capture: true, passive: false });
    cv.__velocityWheelBound = true;
  }
  ["vel-v","vel-x0","vel-z0","vel-dx","vel-dt"].forEach(id => $(`#${id}`).oninput = () => {
    if (id === "vel-x0" || id === "vel-z0") velocityFixedPoint = { x0: Number($("#vel-x0").value), z0: Number($("#vel-z0").value) };
    redraw();
  });
  redraw();
}
function updateVelocityList() {
  $("#velocity-list").innerHTML = velocityPoints.length ? velocityPoints.map((p, i) => {
    const epsr = ((0.299792458 / p.v) ** 2).toFixed(2);
    return `<div>${i + 1}. 道 ${p.x0}, 样点 ${p.z0}, V=${p.v.toFixed(3)} m/ns, εr=${epsr}</div>`;
  }).join("") : "暂无速度点";
}

function renderModel() {
  const cv = $("#model-canvas"), rect = cv.parentElement.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  cv.width = rect.width * dpr; cv.height = rect.height * dpr; const ctx = cv.getContext("2d"); ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.fillStyle = "#0d1219"; ctx.fillRect(0,0,rect.width,rect.height);
  ctx.strokeStyle = "#28364a"; for (let x=0;x<rect.width;x+=24){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,rect.height);ctx.stroke();} for(let y=0;y<rect.height;y+=24){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(rect.width,y);ctx.stroke();}
  model.objects.forEach(o => {
    ctx.fillStyle = o.type === "circle" ? "rgba(77,139,255,.35)" : "rgba(255,176,32,.35)";
    ctx.strokeStyle = "#eaf0f8";
    if (o.type === "circle") { ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, Math.PI*2); ctx.fill(); ctx.stroke(); }
    else { ctx.beginPath(); o.points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)); ctx.closePath(); ctx.fill(); ctx.stroke(); }
  });
  $("#model-list").innerHTML = model.objects.length ? model.objects.map((o,i)=>`<div>${i+1}. ${o.type} εr=${o.epsr}</div>`).join("") : "暂无物体";
}
function bindModel() {
  let pts = [];
  $("#model-canvas").onclick = e => {
    const r = e.target.getBoundingClientRect(), p = { x: e.clientX-r.left, y: e.clientY-r.top };
    if (modelTool === "circle") model.objects.push({ type:"circle", x:p.x, y:p.y, r:35, epsr:15, sigma:0, mu:1 });
    else if (modelTool === "polygon") { pts.push(p); if (pts.length >= 3) { model.objects.push({ type:"polygon", points:pts, epsr:15, sigma:0, mu:1 }); pts = []; } }
    renderModel();
  };
}

function create3D() {
  if (!store.current) return toast("请先导入多条或一条数据", "warn");
  const ds = store.current, yCount = Math.max(1, store.ipd ? 1 : 1);
  threeVolume = { nx: ds.numTraces, ny: yCount, nz: ds.numSamples, data: ds.data };
  $("#three-info").textContent = `3D volume: ${threeVolume.nx} × ${threeVolume.ny} × ${threeVolume.nz}`;
  renderThree();
  toast("3D 数据体已生成（第一版使用当前剖面作为单测线体）");
}
function renderThree() {
  const cv = $("#three-canvas"); if (!cv || !threeVolume) return;
  const rect = cv.getBoundingClientRect(), dpr = devicePixelRatio || 1, ctx = cv.getContext("2d");
  cv.width = rect.width * dpr; cv.height = rect.height * dpr; ctx.setTransform(dpr,0,0,dpr,0,0);
  const w = Math.floor(rect.width), h = Math.floor(rect.height), img = ctx.createImageData(w,h), idx = Number($("#three-index").value || 0);
  const ds = store.current, ns = ds.numSamples, nt = ds.numTraces;
  for (let y=0;y<h;y++) for(let x=0;x<w;x++) {
    const t = Math.floor(x/w*nt), s = Math.floor(y/h*ns), v = ds.data[t*ns+s], q = Math.max(0, Math.min(255, (v+10)/20*255)), i=(y*w+x)*4;
    img.data[i]=q; img.data[i+1]=q; img.data[i+2]=q; img.data[i+3]=255;
  }
  ctx.putImageData(img,0,0);
}

function normalizeSelection(sel) {
  return { startT: Math.min(sel.startT, sel.endT), endT: Math.max(sel.startT, sel.endT) };
}
function clearInteractionState() {
  radarSelections = [];
  radarAnnotations = [];
  lastMergedSelection = null;
  geologyResult = null;
  geologyPipelineState = {};
  activeGeoPipelineOp = "";
  manualInterpretationState = null;
  manualFeatureResult = null;
  manualModelResult = null;
  radar.setSelections([]);
  radar.setAnnotations([]);
  updateSelectionPanel();
  updateAnnotationPanel();
  if ($("#geo-report")) $("#geo-report").innerHTML = "尚未生成自动地质模型。";
  if ($("#manual-geo-report")) $("#manual-geo-report").innerHTML = "手动解释工作台尚未生成模型。";
  if ($("#manual-layer-list")) $("#manual-layer-list").innerHTML = "尚未创建手动层位。";
  updateGeoPipelineButtons();
}
function toggleFloat(id) {
  const el = $(`#${id}`);
  if (!el) return;
  el.classList.toggle("show");
}
function setRadarMode(mode) {
  radar.setMode(mode);
  $$("[data-radar-mode]").forEach(btn => btn.classList.toggle("active", btn.dataset.radarMode === radar.mode));
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function dataFileName(name, ext = ".2b") {
  const clean = String(name || "data").trim().replace(/[\\/:*?"<>|]+/g, "_").replace(/\.\w+$/i, "");
  return `${clean || "data"}${ext}`;
}
function renderSideDatasetList() {
  const list = $("#side-dataset-list");
  if (!list) return;
  const items = store.managedDatasets || [];
  list.innerHTML = items.length ? items.map(item => {
    const current = item.isCurrent ? " current" : "";
    const format = item.meta?.sourceFormat || item.sourceFormat || "data";
    return `<button class="side-dataset-item${current}" data-side-use="${item.id}" title="${escapeHtml(item.name)}">
      <span>${escapeHtml(item.name)}</span>
      <small>${escapeHtml(format)} · ${item.numTraces}×${item.numSamples}</small>
    </button>`;
  }).join("") : "暂无数据";
}
function renderDataManager() {
  const body = $("#data-manager-body");
  if (!body) return;
  const items = store.managedDatasets || [];
  const ids = new Set(items.map(item => item.id));
  for (const id of [...dataManagerSelection]) if (!ids.has(id)) dataManagerSelection.delete(id);
  const selectedItems = items.filter(item => dataManagerSelection.has(item.id));
  $("#data-manager-count").textContent = `${items.length} 个数据集`;
  $("#data-manager-empty").classList.toggle("hidden", items.length > 0);
  $("#data-manager-selection").textContent = selectedItems.length ? `已选择 ${selectedItems.length} 个数据集，共 ${selectedItems.reduce((sum, item) => sum + item.numTraces, 0)} 道` : "未选择数据";
  $("#data-merge-export").disabled = selectedItems.length < 2 || selectedItems.some(item => item.numSamples !== SAMPLES_PER_TRACE);
  $("#data-delete-selected").disabled = selectedItems.length === 0;
  $("#data-clear-selection").disabled = selectedItems.length === 0;
  body.innerHTML = items.map(item => {
    const can2B = item.numSamples === SAMPLES_PER_TRACE;
    const checked = dataManagerSelection.has(item.id) ? "checked" : "";
    const status = item.managedStatus ? `<span class="data-status">${escapeHtml(item.managedStatus)}</span>` : "";
    return `<tr class="${item.isCurrent ? "current" : ""}">
      <td><input type="checkbox" data-data-select="${item.id}" ${checked} title="${can2B ? "可选择合并导出或删除" : "可删除；样点数不是 2048，不能合并导出 .2B"}"></td>
      <td class="data-name-cell"><div class="data-name-main"><button data-data-use="${item.id}" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</button><span class="data-tag">${escapeHtml(item.managedKind || "数据")}</span>${status}</div></td>
      <td>${item.numTraces}</td>
      <td>${item.numSamples}</td>
      <td>${escapeHtml(item.managedCreatedAt || item.loadedAt || "")}</td>
      <td><div class="data-actions-cell">
        <button data-data-use="${item.id}">设为当前</button>
        <button data-data-rename="${item.id}">重命名</button>
        <button data-data-export="${item.id}" ${can2B ? "" : "disabled"}>导出 .2B</button>
      </div></td>
    </tr>`;
  }).join("");
}
function deleteSelectedManagedDatasets() {
  const selected = [...dataManagerSelection];
  if (!selected.length) return toast("请先选择要删除的数据", "warn");
  const deleted = store.deleteManagedDatasets(selected);
  dataManagerSelection.clear();
  clearInteractionState();
  renderDataManager();
  if (deleted) toast(`已删除 ${deleted} 个数据集`);
  else toast("没有删除任何数据", "warn");
}
function useManagedDataset(id) {
  if (!store.useManagedDataset(id)) return toast("没有找到该数据集", "warn");
  displaySource = "current";
  $("#display-mode").value = "current";
  clearInteractionState();
  switchPage("radar");
  toast("已切换为当前数据");
}
function renameManagedDataset(id) {
  const item = store.getManagedDataset(id);
  if (!item) return toast("没有找到该数据集", "warn");
  const name = prompt("数据集名称", item.name || "data");
  if (name == null) return;
  store.renameManagedDataset(id, name) ? toast("名称已更新") : toast("名称不能为空", "warn");
}
function exportManagedDataset(id) {
  const item = store.getManagedDataset(id);
  if (!item) return toast("没有找到该数据集", "warn");
  if (item.numSamples !== SAMPLES_PER_TRACE) return toast(".2B 导出要求每道 2048 样点", "warn");
  download(write2BFile(item), dataFileName(item.name));
  toast("导出完成");
}
function radarParamSignature(ds) {
  const rp = getEffectiveRadarParams(ds);
  return [
    ds.meta?.sourceFormat || ds.sourceFormat || "data",
    rp.dtNs.toFixed(6),
    rp.dxM.toFixed(6),
    rp.velocityMPerNs.toFixed(6),
    rp.vofhText
  ].join("|");
}
function mergeSelectedManagedDatasets() {
  const selected = (store.managedDatasets || []).filter(item => dataManagerSelection.has(item.id));
  if (selected.length < 2) return toast("请至少选择两个 .2B 数据集", "warn");
  if (selected.some(item => item.numSamples !== SAMPLES_PER_TRACE)) return toast("只能合并每道 2048 样点的 .2B 数据集", "warn");
  const signature = radarParamSignature(selected[0]);
  if (selected.some(item => radarParamSignature(item) !== signature)) return toast("所选数据的格式或雷达参数不一致，请先统一 dt/dx/速度模型后再合并", "warn");
  const merged = merge2BDatasets(selected);
  download(write2BFile(merged), merged.name);
  toast(`已合并导出 ${selected.length} 个数据集，共 ${merged.numTraces} 道`);
}
function merge2BDatasets(datasets) {
  const numTraces = datasets.reduce((sum, ds) => sum + ds.numTraces, 0);
  const data = new Float32Array(numTraces * SAMPLES_PER_TRACE);
  let traceOffset = 0;
  for (const ds of datasets) {
    data.set(ds.data.subarray(0, ds.numTraces * SAMPLES_PER_TRACE), traceOffset * SAMPLES_PER_TRACE);
    traceOffset += ds.numTraces;
  }
  return {
    data,
    meta: mergeMetaArrays(datasets, numTraces),
    numTraces,
    numSamples: SAMPLES_PER_TRACE,
    name: `merged_${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}.2b`,
    fileSize: numTraces * RECORD_SIZE
  };
}
function mergeMetaArrays(datasets, numTraces) {
  const base = datasets[0]?.meta || {};
  const out = {
    ...base,
    sourceFormat: ".2B",
    radarParams: base.radarParams ? { ...base.radarParams } : undefined,
    headerSuggestions: base.headerSuggestions ? { ...base.headerSuggestions, mergedFrom: datasets.length } : { mergedFrom: datasets.length }
  };
  const keys = ["antennaId","timestamp","velocity","posX","posY","posZ","attX","attY","attZ","validLen","quality"];
  for (const key of keys) {
    const first = datasets.find(ds => ds.meta?.[key])?.meta?.[key];
    if (!first) continue;
    const arr = new first.constructor(numTraces);
    let offset = 0;
    for (const ds of datasets) {
      const src = ds.meta?.[key];
      if (src) arr.set(src.subarray ? src.subarray(0, Math.min(src.length, ds.numTraces)) : src.slice(0, ds.numTraces), offset);
      offset += ds.numTraces;
    }
    out[key] = arr;
  }
  return out;
}
function copyMeta(meta, indices) {
  if (!meta) return null;
  const out = {
    ...meta,
    radarParams: meta.radarParams ? { ...meta.radarParams } : undefined,
    headerSuggestions: meta.headerSuggestions ? { ...meta.headerSuggestions } : undefined
  };
  const keys = ["antennaId","timestamp","velocity","posX","posY","posZ","attX","attY","attZ","validLen","quality"];
  for (const key of keys) {
    if (!meta[key]) continue;
    const Ctor = meta[key].constructor;
    out[key] = new Ctor(indices.length);
    indices.forEach((src, i) => out[key][i] = meta[key][src]);
  }
  out.sourceFormat = meta.sourceFormat;
  return out;
}
function datasetFromSelections(source, selections) {
  if (!source || !selections.length) return null;
  const sorted = selections.map(normalizeSelection).sort((a, b) => a.startT - b.startT);
  const indices = [];
  for (const sel of sorted) {
    const start = Math.max(0, sel.startT), end = Math.min(source.numTraces - 1, sel.endT);
    for (let t = start; t <= end; t++) indices.push(t);
  }
  const data = new Float32Array(indices.length * source.numSamples);
  indices.forEach((src, i) => data.set(source.data.subarray(src * source.numSamples, src * source.numSamples + source.numSamples), i * source.numSamples));
  return {
    data,
    meta: copyMeta(source.meta, indices),
    numTraces: indices.length,
    numSamples: source.numSamples,
    name: `${(source.name || "data").replace(/\.2b$/i, "")}_selection.2b`,
    fileSize: indices.length * RECORD_SIZE
  };
}
function updateSelectionPanel() {
  radar.setSelections(radarSelections);
  const list = $("#selection-list"), summary = $("#selection-summary");
  const canExport = !!lastMergedSelection || radarSelections.length > 0;
  $("#btn-selection-2b") && ($("#btn-selection-2b").disabled = !canExport);
  $("#btn-selection-pdf") && ($("#btn-selection-pdf").disabled = !canExport);
  $("#btn-selection-extract") && ($("#btn-selection-extract").disabled = !radarSelections.length);
  if (!list || !summary) return;
  if (!radarSelections.length) {
    summary.textContent = lastMergedSelection ? `已合并 ${lastMergedSelection.numTraces} 道，可继续导出。` : "";
    list.innerHTML = `<p class="muted">使用工具栏“选区”在剖面上拖拽选择道范围。</p>`;
    drawSelectionPreview();
    return;
  }
  const total = radarSelections.reduce((s, x) => s + x.endT - x.startT + 1, 0);
  summary.textContent = `${radarSelections.length} 个选区，共 ${total} 道`;
  list.innerHTML = radarSelections.map((s, i) => `<div class="selection-row"><b>#${i + 1}</b><span>T${s.startT}-${s.endT}</span><span>${s.endT - s.startT + 1} 道</span><button data-selection-extract="${i}">提取</button><button data-selection-zoom="${i}">缩放</button><button data-selection-remove="${i}">删除</button></div>`).join("");
  drawSelectionPreview();
}
function updateAnnotationPanel() {
  radar.setAnnotations(radarAnnotations);
  const list = $("#annotation-list");
  if (!list) return;
  if (!radarAnnotations.length) {
    list.innerHTML = `<p class="muted">暂无标注。</p>`;
    return;
  }
  list.innerHTML = radarAnnotations.map((a, i) => {
    const text = a.type === "point" ? `${a.label || "P"}: T${a.t}, S${a.s}` : `${a.type}: T${a.t1}-${a.t2}, S${a.s1}-${a.s2}`;
    return `<div class="selection-row"><b>#${i + 1}</b><span>${text}</span><button data-annotation-remove="${i}">删除</button></div>`;
  }).join("");
}
function extractSelections(index = null) {
  const ds = currentDisplayed();
  if (!ds) return toast("请先导入数据", "warn");
  const selections = index == null ? radarSelections : [radarSelections[index]];
  const merged = datasetFromSelections(ds, selections);
  if (!merged) return toast("请先创建选区", "warn");
  lastMergedSelection = merged;
  store.setOutput(merged, { name: index == null ? "合并选区提取" : "单选区提取", op: "selection-extract", params: { selections } });
  displaySource = "output"; $("#display-mode").value = "output";
  updateSelectionPanel();
  drawSelectionPreview();
  toast(`提取完成：${merged.numTraces} 道，结果已放入 Output Data`);
}
function clearSelections() {
  radarSelections = [];
  lastMergedSelection = null;
  updateSelectionPanel();
  toast("选区已清空");
}
function exportSelection(kind) {
  if (!lastMergedSelection) lastMergedSelection = datasetFromSelections(currentDisplayed(), radarSelections);
  if (!lastMergedSelection) return toast("没有可导出的选区数据", "warn");
  if (kind === "2b") download(write2BFile(lastMergedSelection), lastMergedSelection.name);
  else exportPdfDocument(lastMergedSelection, `${lastMergedSelection.name.replace(/\.2b$/i, "")}.pdf`);
}
function colorOf(cmap, t) {
  t = Math.max(0, Math.min(1, t));
  if (cmap === "gray") { const v = Math.round(t * 255); return [v, v, v]; }
  if (cmap === "seismic") return t < .5 ? [0, 0, Math.round(t * 510)] : [Math.round((t - .5) * 510), 0, Math.round((1 - (t - .5) * 2) * 255)];
  if (cmap === "hot") return [Math.min(255, Math.round(t * 765)), Math.min(255, Math.round(Math.max(0, t * 3 - 1) * 255)), Math.min(255, Math.round(Math.max(0, t * 3 - 2) * 255))];
  if (cmap === "cool") return [Math.round(t * 255), Math.round((1 - t) * 255), 255];
  if (cmap === "viridis-like") {
    const stops = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]];
    const pos = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(pos)), f = pos - i;
    return stops[i].map((v, c) => Math.round(v + (stops[i + 1][c] - v) * f));
  }
  if (t < .125) return [0, 0, Math.round(128 + t / .125 * 127)];
  if (t < .375) return [0, Math.round((t - .125) / .25 * 255), 255];
  if (t < .625) return [Math.round((t - .375) / .25 * 255), 255, Math.round(255 - (t - .375) / .25 * 255)];
  if (t < .875) return [255, Math.round(255 - (t - .625) / .25 * 255), 0];
  return [Math.round(255 - (t - .875) / .125 * 127), 0, 0];
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function sanitizeDistanceStep(step, traceCount = 0, fallbackStep = NaN) {
  for (const candidate of [step, fallbackStep]) {
    const v = Number(candidate);
    const total = v * Math.max(1, traceCount - 1);
    if (Number.isFinite(v) && v > 0 && v < 1000 && total < 1_000_000) return v;
  }
  return NaN;
}

function axisNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  const a = Math.abs(n);
  if (a >= 1000) return n.toFixed(0);
  if (a >= 100) return n.toFixed(1);
  if (a >= 10) return n.toFixed(1);
  return n.toFixed(2).replace(/\.?0+$/, "");
}

function setupCanvas(canvas, opts = {}) {
  const rect = !opts.width && !opts.height ? canvas.parentElement?.getBoundingClientRect?.() : null;
  const cssW = Math.max(1, Math.floor(opts.width || rect?.width || canvas.clientWidth || canvas.width || 900));
  const cssH = Math.max(1, Math.floor(opts.height || rect?.height || canvas.clientHeight || canvas.height || 320));
  const dpr = Math.max(1, Number(opts.pixelRatio || devicePixelRatio || 1));
  canvas.width = Math.max(1, Math.floor(cssW * dpr));
  canvas.height = Math.max(1, Math.floor(cssH * dpr));
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, cssW, cssH, dpr };
}

function plotLayout(width, height, opts = {}) {
  if (opts.axes !== true) return { plot: { x: 0, y: 0, w: width, h: height }, axes: false, colorbar: false };
  const colorbar = opts.colorbar === true;
  let left = opts.leftMargin ?? (width < 520 ? 58 : 68);
  let bottom = opts.bottomMargin ?? (height < 220 ? 38 : 46);
  let top = opts.topMargin ?? 12;
  let right = opts.rightMargin ?? (colorbar ? 58 : 16);
  if (width - left - right < 120) { left = 44; right = colorbar ? 46 : 8; }
  if (height - top - bottom < 80) { top = 8; bottom = 32; }
  const plot = {
    x: left,
    y: top,
    w: Math.max(1, width - left - right),
    h: Math.max(1, height - top - bottom)
  };
  return { plot, axes: true, colorbar };
}

function datasetPlotScale(ds, opts, layout) {
  const traces = Math.max(1, ds?.numTraces || opts.traceCount || 1);
  const samples = Math.max(1, ds?.numSamples || opts.sampleCount || 1);
  const sampleMax = Math.max(1, Math.min(samples, Math.floor(opts.sampleMax || samples)));
  let traceStart = clampNumber(opts.traceStart ?? 0, 0, traces - 1);
  let traceEnd = clampNumber(opts.traceEnd ?? traces - 1, 0, traces - 1);
  if (traceEnd < traceStart) [traceStart, traceEnd] = [traceEnd, traceStart];
  if (traceEnd - traceStart < 1) traceEnd = Math.min(traces - 1, traceStart + 1);
  let sampleStart = clampNumber(opts.sampleStart ?? 0, 0, sampleMax);
  let sampleEnd = clampNumber(opts.sampleEnd ?? sampleMax, 0, sampleMax);
  if (sampleEnd < sampleStart) [sampleStart, sampleEnd] = [sampleEnd, sampleStart];
  if (sampleEnd - sampleStart < 1) sampleEnd = Math.min(sampleMax, sampleStart + 1);
  const depthMax = Math.max(1e-9, Number(opts.depthMax || opts.modelDepthMax || sampleMax));
  const depthStep = Math.max(1e-12, Number(opts.depthStep || depthMax / Math.max(1, sampleMax)));
  const depthStart = opts.depthStart ?? sampleStart * depthStep;
  const depthEnd = opts.depthEnd ?? sampleEnd * depthStep;
  const distanceStep = sanitizeDistanceStep(opts.distanceStep, traces, opts.fallbackDistanceStep);
  return { traces, samples, sampleMax, traceStart, traceEnd, sampleStart, sampleEnd, depthMax, depthStep, depthStart, depthEnd, distanceStep, layout };
}

function traceToPlotX(trace, render) {
  const { plot } = render.layout, s = render.scale;
  return plot.x + (trace - s.traceStart) / Math.max(1e-9, s.traceEnd - s.traceStart) * plot.w;
}

function sampleToPlotY(sample, render) {
  const { plot } = render.layout, s = render.scale;
  return plot.y + (sample - s.sampleStart) / Math.max(1e-9, s.sampleEnd - s.sampleStart) * plot.h;
}

function depthToPlotY(depth, render) {
  const { plot } = render.layout, s = render.scale;
  return plot.y + (depth - s.depthStart) / Math.max(1e-9, s.depthEnd - s.depthStart) * plot.h;
}

function plotToTraceSample(x, y, render) {
  const { plot } = render.layout, s = render.scale;
  if (x < plot.x || x > plot.x + plot.w || y < plot.y || y > plot.y + plot.h) return null;
  const trace = s.traceStart + (x - plot.x) / Math.max(1, plot.w) * (s.traceEnd - s.traceStart);
  const sample = s.sampleStart + (y - plot.y) / Math.max(1, plot.h) * (s.sampleEnd - s.sampleStart);
  return {
    traceIndex: Math.max(0, Math.min(s.traces - 1, Math.round(trace))),
    sampleIndex: Math.max(0, Math.min(s.samples - 1, Math.round(sample)))
  };
}

function drawPlotAxes(ctx, render, opts = {}) {
  if (opts.axes !== true) return;
  const { cssW, cssH, layout, scale } = render;
  const { plot } = layout;
  const ticksX = plot.w < 260 ? 3 : 5;
  const ticksY = plot.h < 180 ? 3 : 5;
  ctx.save();
  ctx.strokeStyle = "rgba(238,246,255,.82)";
  ctx.fillStyle = "#f8fcff";
  ctx.lineWidth = 1.1;
  ctx.font = `${plot.w < 260 ? 10 : 11}px Consolas, monospace`;
  ctx.shadowColor = "rgba(0,0,0,.55)";
  ctx.shadowBlur = 3;
  ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w - 1, plot.h - 1);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let i = 0; i <= ticksX; i++) {
    const f = i / ticksX;
    const x = plot.x + f * plot.w;
    const trace = scale.traceStart + f * (scale.traceEnd - scale.traceStart);
    const label = Number.isFinite(scale.distanceStep) ? `${axisNumber(trace * scale.distanceStep)} m` : `T${Math.round(trace)}`;
    ctx.beginPath(); ctx.moveTo(x, plot.y + plot.h); ctx.lineTo(x, plot.y + plot.h + 7); ctx.stroke();
    ctx.fillText(label, x, plot.y + plot.h + 10);
  }
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= ticksY; i++) {
    const f = i / ticksY;
    const y = plot.y + f * plot.h;
    const depth = scale.depthStart + f * (scale.depthEnd - scale.depthStart);
    ctx.beginPath(); ctx.moveTo(plot.x - 7, y); ctx.lineTo(plot.x, y); ctx.stroke();
    ctx.fillText(`${axisNumber(depth)} m`, plot.x - 10, y);
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(Number.isFinite(scale.distanceStep) ? "Distance (m)" : "Trace", plot.x + plot.w / 2, cssH - 4);
  ctx.save();
  ctx.translate(16, plot.y + plot.h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("Depth (m)", 0, 0);
  ctx.restore();
  if (layout.colorbar) {
    const bx = plot.x + plot.w + 14, by = plot.y, bw = 14, bh = plot.h;
    const gradSteps = Math.max(1, Math.floor(bh));
    for (let y = 0; y < gradSteps; y++) {
      const [r, g, b] = colorOf(opts.cmap || "seismic", 1 - y / Math.max(1, gradSteps - 1));
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(bx, by + y, bw, 1);
    }
    ctx.strokeStyle = "rgba(238,246,255,.65)";
    ctx.strokeRect(bx, by, bw, bh);
    ctx.fillStyle = "#f8fcff";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(axisNumber(opts.max ?? 1), bx + bw + 5, by);
    ctx.textBaseline = "bottom";
    ctx.fillText(axisNumber(opts.min ?? 0), bx + bw + 5, by + bh);
  }
  ctx.restore();
}

function horizonDepthAtTrace(hzn, trace, traceCount = 1) {
  const line = hzn?.line || [];
  if (!line.length) return NaN;
  if (line.length === 1 || traceCount <= 1) return Number.isFinite(line[0]) ? line[0] : NaN;
  const pos = trace / Math.max(1, traceCount - 1) * (line.length - 1);
  const i = Math.max(0, Math.min(line.length - 1, Math.floor(pos)));
  const j = Math.min(line.length - 1, i + 1);
  const f = pos - i;
  const a = Number(line[i]), b = Number(line[j]);
  if (Number.isFinite(a) && Number.isFinite(b)) return a + (b - a) * f;
  return Number.isFinite(a) ? a : (Number.isFinite(b) ? b : NaN);
}

function renderDatasetCanvas(canvas, ds, opts = {}) {
  if (!canvas || !ds) return;
  const prepared = setupCanvas(canvas, opts);
  const layout = plotLayout(prepared.cssW, prepared.cssH, opts);
  const render = { ...prepared, layout, scale: datasetPlotScale(ds, opts, layout) };
  const { ctx } = render, { plot } = layout;
  const min = Number(opts.min ?? -10), max = Number(opts.max ?? 10), range = max - min || 1;
  ctx.fillStyle = opts.background || "#080c14";
  ctx.fillRect(0, 0, prepared.cssW, prepared.cssH);
  const plotW = Math.max(1, Math.floor(plot.w)), plotH = Math.max(1, Math.floor(plot.h));
  const off = document.createElement("canvas");
  off.width = plotW; off.height = plotH;
  const offCtx = off.getContext("2d");
  const img = offCtx.createImageData(plotW, plotH);
  for (let y = 0; y < plotH; y++) {
    const sample = render.scale.sampleStart + y / Math.max(1, plotH - 1) * (render.scale.sampleEnd - render.scale.sampleStart);
    const s = Math.max(0, Math.min(ds.numSamples - 1, Math.round(sample)));
    for (let x = 0; x < plotW; x++) {
      const trace = render.scale.traceStart + x / Math.max(1, plotW - 1) * (render.scale.traceEnd - render.scale.traceStart);
      const t = Math.max(0, Math.min(ds.numTraces - 1, Math.round(trace)));
      const [r, g, b] = colorOf(opts.cmap || "seismic", (ds.data[t * ds.numSamples + s] - min) / range);
      const i = (y * plotW + x) * 4; img.data[i] = r; img.data[i+1] = g; img.data[i+2] = b; img.data[i+3] = 255;
    }
  }
  offCtx.putImageData(img, 0, 0);
  ctx.drawImage(off, plot.x, plot.y, plot.w, plot.h);
  if (opts.horizons?.length) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.w, plot.h);
    ctx.clip();
    ctx.lineWidth = 1.3; ctx.setLineDash([5,3]);
    const colors = ["#ffe066","#69db7c","#74c0fc","#ff922b","#da77f2","#63e6be"];
    opts.horizons.forEach((hzn, i) => {
      ctx.strokeStyle = colors[i % colors.length]; ctx.beginPath();
      let started = false;
      for (let x = 0; x <= plotW; x++) {
        const trace = render.scale.traceStart + x / Math.max(1, plotW) * (render.scale.traceEnd - render.scale.traceStart);
        const depth = horizonDepthAtTrace(hzn, trace, render.scale.traces);
        if (!Number.isFinite(depth)) { started = false; continue; }
        const y = depthToPlotY(depth, render);
        const px = plot.x + x / Math.max(1, plotW) * plot.w;
        if (y < plot.y - 4 || y > plot.y + plot.h + 4) { started = false; continue; }
        started ? ctx.lineTo(px, y) : ctx.moveTo(px, y);
        started = true;
      }
      ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.restore();
  }
  if (opts.clusters?.length) {
    ctx.save();
    ctx.beginPath(); ctx.rect(plot.x, plot.y, plot.w, plot.h); ctx.clip();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = "#63e6be";
    ctx.setLineDash([7, 5]);
    for (const c of opts.clusters) {
      const depth = Number(c.depth ?? c.meanDepth ?? c.medianDepth);
      if (!Number.isFinite(depth)) continue;
      const y = depthToPlotY(depth, render);
      if (y < plot.y || y > plot.y + plot.h) continue;
      ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke();
    }
    ctx.restore();
  }
  if (opts.peaks?.length) {
    ctx.save();
    ctx.beginPath(); ctx.rect(plot.x, plot.y, plot.w, plot.h); ctx.clip();
    ctx.fillStyle = "#fff200";
    ctx.strokeStyle = "rgba(2,8,18,.85)";
    const stride = Math.max(1, Math.ceil(opts.peaks.length / 2500));
    for (let i = 0; i < opts.peaks.length; i += stride) {
      const p = opts.peaks[i];
      const trace = Number(p.t ?? p.trace ?? p.traceIndex) || 0;
      if (trace < render.scale.traceStart || trace > render.scale.traceEnd) continue;
      const depth = Number.isFinite(Number(p.depth)) ? Number(p.depth) : (Number(p.sample ?? p.sampleIndex) || 0) * render.scale.depthStep;
      const x = traceToPlotX(trace, render), y = depthToPlotY(depth, render);
      if (y < plot.y || y > plot.y + plot.h) continue;
      ctx.beginPath(); ctx.arc(x, y, 2.1, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
  drawPlotAxes(ctx, render, opts);
  return render;
}
function drawSelectionPreview() {
  if (!$("#selection-preview")) return;
  renderDatasetCanvas($("#selection-preview"), lastMergedSelection, { cmap: "jet", min: -10, max: 10 });
}
function exportPng(ds, name) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(ds.numTraces, 4000); canvas.height = Math.min(ds.numSamples, 4000);
  renderDatasetCanvas(canvas, ds, { cmap: $("#export-cmap")?.value || "gray", min: Number($("#amp-min").value || -10), max: Number($("#amp-max").value || 10) });
  canvas.toBlob(blob => download(blob, name));
}
function exportPdfDocument(ds, name) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.min(ds.numTraces, 3000); canvas.height = Math.min(ds.numSamples, 2400);
  renderDatasetCanvas(canvas, ds, { cmap: $("#export-cmap")?.value || "gray", min: -10, max: 10 });
  const url = canvas.toDataURL("image/png");
  const html = `<!doctype html><title>${ds.name}</title><body style="font-family:Arial,sans-serif;margin:24px"><h2>${ds.name}</h2><p>Traces: ${ds.numTraces}, Samples: ${ds.numSamples}, Created: ${new Date().toISOString()}</p><img src="${url}" style="max-width:100%"><script>print()<\/script></body>`;
  const win = window.open("", "_blank");
  if (win) {
    win.document.write(html);
    win.document.close();
    toast("已打开打印窗口，可保存为 PDF", "warn");
  } else {
    download(new Blob([html], { type: "text/html" }), name.replace(/\.pdf$/i, ".html"));
    toast("弹窗被拦截，已导出可打印 HTML", "warn");
  }
}
function exportCsv(ds) {
  const rows = [];
  for (let s = 0; s < ds.numSamples; s++) {
    const row = [];
    for (let t = 0; t < ds.numTraces; t++) row.push(ds.data[t * ds.numSamples + s].toFixed(6));
    rows.push(row.join(","));
  }
  return new Blob([rows.join("\n")], { type: "text/csv" });
}
async function runGeologyModel() {
  const ds = currentDisplayed();
  if (!ds) return toast("请先导入数据", "warn");
  syncGeoControlsFromDataset();
  const params = collectGeoParams(ds);
  $("#footer-status").textContent = "正在自动提取界面并生成地质模型";
  try {
    geologyResult = await runWorker("geology-model", ds, params);
    store.setOutput({
      data: geologyResult.data,
      numTraces: geologyResult.numTraces,
      numSamples: geologyResult.numSamples,
      name: `${ds.name || "data"}_geology_processed`,
      meta: geologyResult.meta || ds.meta,
      dtNs: geologyResult.dtNs || params.dt,
      dxM: geologyResult.dxM || params.dx,
      depthStep: geologyResult.depthStep,
      depthAxisM: geologyResult.meta?.depthAxisM
    }, { name: "自动地质建模", op: "geology-model", params });
    displaySource = "output"; $("#display-mode").value = "output";
    drawGeologyResult();
    $("#footer-status").textContent = "自动地质建模完成，Output Data 已生成";
    toast("自动地质模型已生成");
  } catch (error) {
    toast(error.message, "err");
    $("#footer-status").textContent = "自动地质建模失败";
  }
}

function collectGeoParams(ds = currentDisplayed()) {
  const rp = getEffectiveRadarParams(ds);
  const velocity = finiteNumber($("#geo-velocity")?.value, rp.velocityMPerNs);
  const dt = finiteNumber($("#geo-dt")?.value, rp.dtNs);
  const dx = finiteNumber($("#geo-dx")?.value, rp.dxM);
  return {
    velocity,
    dt,
    dx,
    vofh: rp.vofhText,
    dzM: rp.depthDzM,
    zMaxM: rp.depthMaxM,
    loMHz: Number($("#geo-lo")?.value || rp.freqLowMHz),
    hiMHz: Number($("#geo-hi")?.value || rp.freqHighMHz),
    bgWidth: Number($("#geo-bg")?.value || 25),
    agcWindow: Number($("#geo-agc")?.value || 80),
    modelDepthMax: finiteNumber($("#geo-depth")?.value, inferredDepthMax(ds, dt, velocity)),
    autoMode: $("#geo-auto-mode")?.value || "conservative",
    qualityThreshold: finiteNumber($("#geo-quality-threshold")?.value, 70),
    useMigration: $("#geo-use-migration")?.checked === true,
    preprocess: {
      dewow: $("#geo-use-dewow")?.checked !== false,
      dc: $("#geo-use-dc")?.checked !== false,
      freqFilter: $("#geo-use-freq")?.checked !== false,
      backgroundRemove: $("#geo-use-bg")?.checked !== false,
      slidingBg: $("#geo-use-sliding")?.checked !== false,
      equalize: $("#geo-use-equalize")?.checked === true,
      gainMethod: $("#geo-gain-method")?.value || "gagc"
    }
  };
}

async function runGeoPipelineStep(op) {
  const ds = currentDisplayed();
  if (!ds) return toast("请先导入数据", "warn");
  syncGeoControlsFromDataset();
  const def = geoPipelineDefs.find(x => x[0] === op);
  const params = collectGeoParams(ds);
  $("#footer-status").textContent = `正在运行 ${def?.[1] || op}`;
  try {
    const result = await runWorker(op, ds, params);
    geologyPipelineState[op] = result;
    activeGeoPipelineOp = op;
    updateGeoPipelineButtons(op);
    if (op === "geo-classify-model") {
      geologyResult = result;
      drawGeologyResult();
    }
    drawGeoPipelineResult(op, result, def);
    $("#footer-status").textContent = `${def?.[1] || op} 完成`;
    toast(`${def?.[1] || op} 完成`);
  } catch (error) {
    toast(error.message, "err");
    $("#footer-status").textContent = `${def?.[1] || op} 失败`;
  }
}

function drawGeoPipelineResult(op, result, def) {
  if (!result) return;
  const preview = { data: result.data, numTraces: result.numTraces, numSamples: result.numSamples };
  renderDatasetCanvas($("#geo-step-canvas"), preview, {
    cmap: "seismic",
    min: -2.2,
    max: 2.2,
    horizons: result.horizons || [],
    peaks: result.peaks || [],
    clusters: result.seeds || result.mergedClusters || result.clusters || [],
    modelDepthMax: result.modelDepthMax || 24,
    depthMax: result.modelDepthMax || 24,
    depthStep: result.depthStep,
    distanceStep: result.distanceStep || result.dx,
    axes: true,
    colorbar: true,
    sampleMax: result.depthStep ? Math.ceil((result.modelDepthMax || 24) / result.depthStep) : result.numSamples
  });
  drawGeoStepHistogram(result);
  if (result.modelData) drawLayerModelCanvas($("#geo-step-model-canvas"), result);
  const details = [];
  if (result.peaks) details.push(`峰值 ${result.peaks.length} 个`);
  if (result.clusters) details.push(`聚类 ${result.clusters.length} 个`);
  if (result.mergedClusters) details.push(`合并聚类 ${result.mergedClusters.length} 个`);
  if (result.seeds) details.push(`候选层位 ${result.seeds.length} 个`);
  if (result.horizons) details.push(`层位线 ${result.horizons.length} 条`);
  if (result.modelData) details.push(`模型 ${result.modelTraces} 道 × ${result.modelSamples} 深度格`);
  const report = $("#geo-step-report");
  if (report) report.innerHTML = `<b>${escapeHtml(def?.[1] || op)}</b><p>${escapeHtml(def?.[2] || "")}</p><p>${escapeHtml(details.join("；") || "已生成预览数据。")}</p><p class="muted">每步会自动补齐前置计算，并在自动建模页展示全过程；手动解释工作台不会被覆盖。</p>`;
}
function updateGeoPipelineButtons(activeOp = "") {
  $$("[data-geo-step]").forEach(btn => {
    const op = btn.dataset.geoStep;
    btn.classList.toggle("completed", !!geologyPipelineState[op]);
    btn.classList.toggle("active", op === activeOp);
  });
}

function drawManualGeoResult() {
  if (!activeGeoPipelineOp) return;
  const def = geoPipelineDefs.find(x => x[0] === activeGeoPipelineOp);
  const result = geologyPipelineState[activeGeoPipelineOp];
  if (result) drawGeoPipelineResult(activeGeoPipelineOp, result, def);
}

function drawGeoStepHistogram(result) {
  const canvas = $("#geo-step-chart-canvas");
  if (!canvas) return;
  const rect = canvas.parentElement?.getBoundingClientRect?.() || { width: 900, height: 180 };
  const dpr = devicePixelRatio || 1, w = Math.max(1, Math.floor(rect.width)), h = Math.max(1, Math.floor(rect.height));
  canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#080c14"; ctx.fillRect(0, 0, w, h);
  if (!result.histogram?.length) {
    ctx.fillStyle = "#91a7c7"; ctx.font = "12px Consolas"; ctx.fillText("Histogram appears after depth histogram / clustering steps.", 14, 24);
    return;
  }
  const hist = result.histogram;
  const max = Math.max(...hist) || 1;
  const m = { l: 54, r: 12, t: 14, b: 28 };
  ctx.strokeStyle = "rgba(248,252,255,.45)";
  ctx.fillStyle = "#f8fcff";
  ctx.font = "11px Consolas";
  ctx.strokeRect(m.l, m.t, w - m.l - m.r, h - m.t - m.b);
  for (let i = 0; i < hist.length; i++) {
    const x0 = m.l + i / hist.length * (w - m.l - m.r);
    const x1 = m.l + (i + 1) / hist.length * (w - m.l - m.r);
    const bh = hist[i] / max * (h - m.t - m.b);
    ctx.fillStyle = "#74c0fc";
    ctx.fillRect(x0 + 1, h - m.b - bh, Math.max(1, x1 - x0 - 2), bh);
  }
  ctx.fillStyle = "#f8fcff";
  ctx.textAlign = "center";
  ctx.fillText("Depth histogram", w / 2, h - 8);
  ctx.textAlign = "right";
  ctx.fillText(max.toFixed(1), m.l - 6, m.t + 10);
}

const GEO_LABELS_SAFE = ["layer 1", "layer 2", "layer 3", "layer 4", "layer 5", "layer 6", "unclassified"];
const manualLayerColors = ["#ffe066", "#74c0fc", "#63e6be", "#ff922b", "#da77f2", "#69db7c", "#ff6b6b", "#91a7ff"];

function finiteMean(values) {
  let sum = 0, n = 0;
  for (const v of values || []) if (Number.isFinite(Number(v))) { sum += Number(v); n++; }
  return n ? sum / n : 0;
}

function lineDepthStats(line) {
  const vals = Array.from(line || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!vals.length) return { meanDepth: 0, medianDepth: 0, minDepth: 0, maxDepth: 0 };
  return {
    meanDepth: finiteMean(vals),
    medianDepth: vals[Math.floor(vals.length / 2)],
    minDepth: vals[0],
    maxDepth: vals[vals.length - 1]
  };
}

function cloneManualLayers(layers = []) {
  return layers.map(layer => ({ ...layer, points: layer.points.map(p => ({ ...p })), metadata: { ...(layer.metadata || {}) } }));
}

function manualDatasetId(ds = currentDisplayed()) {
  return ds ? `${ds.id || ds.name || "data"}:${ds.numTraces}x${ds.numSamples}` : "none";
}

function ensureManualState() {
  const ds = currentDisplayed();
  const id = manualDatasetId(ds);
  if (!manualInterpretationState || manualInterpretationState.datasetId !== id) {
    manualInterpretationState = { datasetId: id, activeLayerId: "", layers: [], displayMode: "radar", snapEnabled: true, cursorTrace: 0, history: [], future: [], view: null };
    manualFeatureResult = null;
    manualModelResult = null;
    manualCanvasRender = null;
  }
  return manualInterpretationState;
}

function pushManualHistory() {
  const st = ensureManualState();
  st.history.push(cloneManualLayers(st.layers));
  if (st.history.length > 40) st.history.shift();
  st.future = [];
}

function createManualLayer(source = "manual") {
  const st = ensureManualState();
  pushManualHistory();
  const id = `H${Date.now().toString(36)}${Math.floor(Math.random() * 999)}`;
  const layer = { id, name: `H${st.layers.length + 1}`, color: manualLayerColors[st.layers.length % manualLayerColors.length], type: "horizon", points: [], visible: true, locked: false, source, confidence: source === "auto" ? 70 : 100, metadata: {} };
  st.layers.push(layer);
  st.activeLayerId = id;
  renderManualLayerList();
  return layer;
}

function activeManualLayer() {
  const st = ensureManualState();
  return st.layers.find(l => l.id === st.activeLayerId && !l.locked) || st.layers.find(l => !l.locked) || createManualLayer();
}

function manualDepthStep(ds = currentDisplayed()) {
  const rp = getEffectiveRadarParams(ds);
  return Math.max(1e-9, rp.dtNs * rp.velocityMPerNs / 2);
}

function manualSampleMax(ds = currentDisplayed()) {
  const rp = getEffectiveRadarParams(ds);
  const depth = finiteNumber($("#geo-depth")?.value, rp.depthMaxM);
  return Math.max(1, Math.min(ds?.numSamples || 1, Math.ceil(depth / manualDepthStep(ds))));
}

function enrichManualPoint(point, ds = currentDisplayed()) {
  const rp = getEffectiveRadarParams(ds);
  return { ...point, depthM: point.sampleIndex * manualDepthStep(ds), distanceM: point.traceIndex * rp.dxM };
}

function manualSnapPoint(point) {
  const st = ensureManualState();
  const ds = currentDisplayed();
  const prob = manualFeatureResult?.boundaryProbability || manualFeatureResult?.data;
  if (!ds || !st.snapEnabled || !prob?.length) return enrichManualPoint(point, ds);
  const radiusS = 10;
  let best = { ...point }, bestScore = -Infinity;
  for (let dt = -1; dt <= 1; dt++) {
    const t = point.traceIndex + dt;
    if (t < 0 || t >= ds.numTraces) continue;
    for (let dsamp = -radiusS; dsamp <= radiusS; dsamp++) {
      const s = point.sampleIndex + dsamp;
      if (s < 0 || s >= ds.numSamples) continue;
      const score = prob[t * ds.numSamples + s];
      if (score > bestScore) { bestScore = score; best = { traceIndex: t, sampleIndex: s, source: "snapped", snapScore: score }; }
    }
  }
  if (bestScore < 0.18) best = point;
  return enrichManualPoint(best, ds);
}

function manualPointFromEvent(e, snap = true) {
  const ds = currentDisplayed(), canvas = $("#manual-geo-radar-canvas");
  if (!ds || !canvas) return null;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const render = manualCanvasRender || { layout: plotLayout(rect.width, rect.height, { axes: true }), scale: datasetPlotScale(ds, { sampleMax: manualSampleMax(ds) }, plotLayout(rect.width, rect.height, { axes: true })) };
  const raw = plotToTraceSample(x, y, render);
  if (!raw) return null;
  const point = { ...raw, source: "manual", snapScore: 0 };
  return snap ? manualSnapPoint(point) : enrichManualPoint(point, ds);
}

function sortLayerPoints(layer) {
  layer.points.sort((a, b) => a.traceIndex - b.traceIndex || a.sampleIndex - b.sampleIndex);
}

function addManualPoint(layer, point, minTraceGap = 1) {
  if (!layer || !point) return;
  const last = layer.points[layer.points.length - 1];
  if (last && Math.abs(last.traceIndex - point.traceIndex) < minTraceGap && Math.abs(last.sampleIndex - point.sampleIndex) < 2) return;
  layer.points.push(point);
  sortLayerPoints(layer);
}

function nearestManualPoint(point, maxPx = 16) {
  const st = ensureManualState(), ds = currentDisplayed(), canvas = $("#manual-geo-radar-canvas");
  if (!ds || !canvas) return null;
  const render = manualCanvasRender;
  if (!render) return null;
  let best = null, bestD = maxPx;
  const qx = traceToPlotX(point.traceIndex, render);
  const qy = sampleToPlotY(point.sampleIndex, render);
  for (const layer of st.layers) {
    if (!layer.visible || layer.locked) continue;
    for (let i = 0; i < layer.points.length; i++) {
      const p = layer.points[i];
      if (p.traceIndex < render.scale.traceStart || p.traceIndex > render.scale.traceEnd || p.sampleIndex < render.scale.sampleStart || p.sampleIndex > render.scale.sampleEnd) continue;
      const px = traceToPlotX(p.traceIndex, render);
      const py = sampleToPlotY(p.sampleIndex, render);
      const dist = Math.hypot(px - qx, py - qy);
      if (dist < bestD) { bestD = dist; best = { layer, index: i, point: p }; }
    }
  }
  return best;
}

function manualDisplayDataset() {
  const ds = currentDisplayed();
  if (!ds) return null;
  const st = ensureManualState();
  const mode = $("#manual-display-mode")?.value || st.displayMode || "radar";
  st.displayMode = mode;
  if (mode === "processed" && manualFeatureResult?.processedData) return { ...ds, data: manualFeatureResult.processedData };
  if (mode === "boundary" && manualFeatureResult?.boundaryProbability) return { ...ds, data: manualFeatureResult.boundaryProbability };
  if (mode === "envelope" && manualFeatureResult?.featureMaps?.envelope) return { ...ds, data: manualFeatureResult.featureMaps.envelope };
  if (mode === "phase" && manualFeatureResult?.featureMaps?.phase) return { ...ds, data: manualFeatureResult.featureMaps.phase };
  if (mode === "frequency" && manualFeatureResult?.featureMaps?.instantFreq) return { ...ds, data: manualFeatureResult.featureMaps.instantFreq };
  if (mode === "semblance" && manualFeatureResult?.featureMaps?.semblance) return { ...ds, data: manualFeatureResult.featureMaps.semblance };
  if (mode === "auto" && geologyResult?.data) return { ...ds, data: geologyResult.data };
  return ds;
}

function manualDisplayRange(mode) {
  if (mode === "boundary" || mode === "semblance") return { min: 0, max: 1, cmap: "hot" };
  if (mode === "envelope") return { min: 0, max: 2.5, cmap: "hot" };
  if (mode === "phase") return { min: -Math.PI, max: Math.PI, cmap: "seismic" };
  if (mode === "frequency") return { min: -0.25, max: 0.25, cmap: "seismic" };
  return { min: -10, max: 10, cmap: "seismic" };
}

function normalizeManualView(view, ds) {
  const sampleMax = manualSampleMax(ds), traceMax = Math.max(1, (ds?.numTraces || 1) - 1);
  view.traceStart = clampNumber(view.traceStart ?? 0, 0, traceMax);
  view.traceEnd = clampNumber(view.traceEnd ?? traceMax, 0, traceMax);
  if (view.traceEnd < view.traceStart) [view.traceStart, view.traceEnd] = [view.traceEnd, view.traceStart];
  if (view.traceEnd - view.traceStart < 4) {
    const c = (view.traceStart + view.traceEnd) / 2;
    view.traceStart = Math.max(0, c - 2);
    view.traceEnd = Math.min(traceMax, c + 2);
  }
  view.sampleStart = clampNumber(view.sampleStart ?? 0, 0, sampleMax);
  view.sampleEnd = clampNumber(view.sampleEnd ?? sampleMax, 0, sampleMax);
  if (view.sampleEnd < view.sampleStart) [view.sampleStart, view.sampleEnd] = [view.sampleEnd, view.sampleStart];
  if (view.sampleEnd - view.sampleStart < 8) {
    const c = (view.sampleStart + view.sampleEnd) / 2;
    view.sampleStart = Math.max(0, c - 4);
    view.sampleEnd = Math.min(sampleMax, c + 4);
  }
  view.min = Number.isFinite(Number(view.min)) ? Number(view.min) : -10;
  view.max = Number.isFinite(Number(view.max)) && Number(view.max) !== view.min ? Number(view.max) : view.min + 1;
  return view;
}

function ensureManualView(ds = currentDisplayed(), mode = null) {
  const st = ensureManualState();
  const displayMode = mode || $("#manual-display-mode")?.value || st.displayMode || "radar";
  const defaults = manualDisplayRange(displayMode);
  if (!st.view || st.view.mode !== displayMode) {
    const old = st.view || {};
    st.view = {
      mode: displayMode,
      traceStart: old.traceStart ?? 0,
      traceEnd: old.traceEnd ?? Math.max(1, (ds?.numTraces || 1) - 1),
      sampleStart: old.sampleStart ?? 0,
      sampleEnd: old.sampleEnd ?? manualSampleMax(ds),
      cmap: old.mode === displayMode ? (old.cmap || defaults.cmap) : defaults.cmap,
      min: old.mode === displayMode ? (old.min ?? defaults.min) : defaults.min,
      max: old.mode === displayMode ? (old.max ?? defaults.max) : defaults.max,
      autoRange: false
    };
  }
  return normalizeManualView(st.view, ds);
}

function syncManualViewControls(view = ensureManualView()) {
  if ($("#manual-cmap")) $("#manual-cmap").value = view.cmap || "seismic";
  if ($("#manual-min")) $("#manual-min").value = Number(view.min).toFixed(3).replace(/\.?0+$/, "");
  if ($("#manual-max")) $("#manual-max").value = Number(view.max).toFixed(3).replace(/\.?0+$/, "");
}

function readManualViewControls() {
  const view = ensureManualView();
  if ($("#manual-cmap")) view.cmap = $("#manual-cmap").value || view.cmap;
  if ($("#manual-min")) view.min = Number($("#manual-min").value);
  if ($("#manual-max")) view.max = Number($("#manual-max").value);
  normalizeManualView(view, currentDisplayed());
  drawManualWorkbench();
}

function resetManualView() {
  const ds = currentDisplayed();
  if (!ds) return;
  const st = ensureManualState();
  const mode = $("#manual-display-mode")?.value || st.displayMode || "radar";
  const defaults = manualDisplayRange(mode);
  st.view = { mode, traceStart: 0, traceEnd: Math.max(1, ds.numTraces - 1), sampleStart: 0, sampleEnd: manualSampleMax(ds), cmap: defaults.cmap, min: defaults.min, max: defaults.max, autoRange: false };
  drawManualWorkbench();
}

function setManualAutoRange() {
  const ds = manualDisplayDataset();
  const source = currentDisplayed();
  if (!ds || !source) return;
  const view = ensureManualView(source);
  const values = [];
  const traceStep = Math.max(1, Math.ceil((view.traceEnd - view.traceStart) / 280));
  const sampleStep = Math.max(1, Math.ceil((view.sampleEnd - view.sampleStart) / 280));
  for (let t = Math.round(view.traceStart); t <= Math.round(view.traceEnd); t += traceStep) {
    if (t < 0 || t >= ds.numTraces) continue;
    for (let s = Math.round(view.sampleStart); s <= Math.round(view.sampleEnd); s += sampleStep) {
      if (s < 0 || s >= ds.numSamples) continue;
      const v = ds.data[t * ds.numSamples + s];
      if (Number.isFinite(v)) values.push(v);
    }
  }
  if (values.length < 8) return toast("当前视窗数据不足，无法自动范围", "warn");
  values.sort((a, b) => a - b);
  view.min = values[Math.floor(values.length * 0.02)];
  view.max = values[Math.floor(values.length * 0.98)];
  if (view.max <= view.min) { view.min -= 1; view.max += 1; }
  view.autoRange = true;
  drawManualWorkbench();
}

function zoomManualViewAt(point, factor, axes = "both") {
  const ds = currentDisplayed();
  if (!ds || !point) return;
  const view = ensureManualView(ds);
  const fx = Math.max(0.02, Math.min(0.98, (point.traceIndex - view.traceStart) / Math.max(1e-9, view.traceEnd - view.traceStart)));
  const fy = Math.max(0.02, Math.min(0.98, (point.sampleIndex - view.sampleStart) / Math.max(1e-9, view.sampleEnd - view.sampleStart)));
  if (axes === "both" || axes === "x") {
    const span = Math.max(4, (view.traceEnd - view.traceStart) * factor);
    view.traceStart = point.traceIndex - span * fx;
    view.traceEnd = point.traceIndex + span * (1 - fx);
  }
  if (axes === "both" || axes === "y") {
    const span = Math.max(8, (view.sampleEnd - view.sampleStart) * factor);
    view.sampleStart = point.sampleIndex - span * fy;
    view.sampleEnd = point.sampleIndex + span * (1 - fy);
  }
  normalizeManualView(view, ds);
  drawManualWorkbench();
}

function panManualView(startView, dxPx, dyPx) {
  const ds = currentDisplayed();
  const render = manualCanvasRender;
  if (!ds || !render || !startView) return;
  const traceDelta = -dxPx / Math.max(1, render.layout.plot.w) * (startView.traceEnd - startView.traceStart);
  const sampleDelta = -dyPx / Math.max(1, render.layout.plot.h) * (startView.sampleEnd - startView.sampleStart);
  const view = ensureManualView(ds);
  view.traceStart = startView.traceStart + traceDelta;
  view.traceEnd = startView.traceEnd + traceDelta;
  view.sampleStart = startView.sampleStart + sampleDelta;
  view.sampleEnd = startView.sampleEnd + sampleDelta;
  normalizeManualView(view, ds);
  drawManualWorkbench();
}

function drawManualWorkbench() {
  const ds = currentDisplayed(), canvas = $("#manual-geo-radar-canvas");
  if (!ds || !canvas) return;
  const st = ensureManualState();
  const mode = $("#manual-display-mode")?.value || st.displayMode || "radar";
  const viewDs = manualDisplayDataset();
  const view = ensureManualView(ds, mode);
  const rp = getEffectiveRadarParams(ds);
  manualCanvasRender = renderDatasetCanvas(canvas, viewDs, {
    cmap: view.cmap,
    min: view.min,
    max: view.max,
    axes: true,
    colorbar: true,
    traceStart: view.traceStart,
    traceEnd: view.traceEnd,
    sampleStart: view.sampleStart,
    sampleEnd: view.sampleEnd,
    depthMax: manualSampleMax(ds) * manualDepthStep(ds),
    sampleMax: manualSampleMax(ds),
    distanceStep: rp.dxM,
    horizons: mode === "auto" ? geologyResult?.horizons || [] : []
  });
  drawManualLayerOverlay();
  renderManualLayerList();
  drawManualTraceAndSpectrum(st.cursorTrace || 0);
  if (manualModelResult) drawLayerModelCanvas($("#manual-geo-model-canvas"), manualModelResult);
  syncManualViewControls(view);
}

function drawManualLayersOnRender(render, layers, activeLayerId = "") {
  if (!render) return;
  const ctx = render.ctx, { plot } = render.layout;
  ctx.save();
  ctx.beginPath(); ctx.rect(plot.x, plot.y, plot.w, plot.h); ctx.clip();
  ctx.lineWidth = 2;
  ctx.font = "12px Consolas";
  for (const layer of layers || []) {
    if (!layer.visible || !layer.points.length) continue;
    ctx.strokeStyle = layer.color;
    ctx.fillStyle = layer.color;
    ctx.globalAlpha = layer.source === "auto" ? 0.58 : 0.95;
    ctx.beginPath();
    layer.points.forEach((p, i) => {
      const x = traceToPlotX(p.traceIndex, render);
      const y = sampleToPlotY(p.sampleIndex, render);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
    for (const p of layer.points) {
      if (p.traceIndex < render.scale.traceStart || p.traceIndex > render.scale.traceEnd || p.sampleIndex < render.scale.sampleStart || p.sampleIndex > render.scale.sampleEnd) continue;
      const x = traceToPlotX(p.traceIndex, render);
      const y = sampleToPlotY(p.sampleIndex, render);
      ctx.beginPath(); ctx.arc(x, y, layer.id === activeLayerId ? 3.5 : 2.2, 0, Math.PI * 2); ctx.fill();
    }
    const first = layer.points.find(p => p.traceIndex >= render.scale.traceStart && p.traceIndex <= render.scale.traceEnd && p.sampleIndex >= render.scale.sampleStart && p.sampleIndex <= render.scale.sampleEnd);
    if (first) ctx.fillText(layer.name, traceToPlotX(first.traceIndex, render) + 4, sampleToPlotY(first.sampleIndex, render) - 6);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawManualLayerOverlay() {
  const st = ensureManualState();
  drawManualLayersOnRender(manualCanvasRender, st.layers, st.activeLayerId);
}

function renderManualLayerList() {
  const st = ensureManualState(), el = $("#manual-layer-list");
  if (!el) return;
  if (!st.layers.length) { el.innerHTML = "尚未创建手动层位。"; return; }
  el.innerHTML = st.layers.map(layer => `<div class="manual-layer-row ${layer.id === st.activeLayerId ? "active" : ""}"><span class="manual-color-dot" style="background:${layer.color}"></span><button data-manual-layer="${layer.id}"><b>${escapeHtml(layer.name)}</b><br><small>${layer.points.length} points · ${layer.source}</small></button><span><button data-manual-visible="${layer.id}">${layer.visible ? "Hide" : "Show"}</button><button data-manual-delete="${layer.id}">Del</button></span></div>`).join("");
}

function drawManualTraceAndSpectrum(traceIndex = 0) {
  const ds = currentDisplayed();
  if (!ds) return;
  const t = Math.max(0, Math.min(ds.numTraces - 1, Math.round(traceIndex)));
  const trace = ds.data.subarray(t * ds.numSamples, t * ds.numSamples + ds.numSamples);
  drawLine($("#manual-geo-chart-canvas"), [...trace], { title: `Trace ${t}` });
  drawLine($("#manual-geo-spectrum-canvas"), [...spectrum(trace)], { title: `Spectrum ${t}`, color: "#63e6be" });
}

async function computeManualAids() {
  const ds = currentDisplayed();
  if (!ds) return toast("请先导入数据", "warn");
  $("#footer-status").textContent = "正在计算手动解释辅助属性";
  manualFeatureResult = await runWorker("geo-energy-envelope", ds, collectGeoParams(ds));
  if ($("#manual-display-mode")) $("#manual-display-mode").value = "boundary";
  drawManualWorkbench();
  $("#footer-status").textContent = "手动解释辅助属性已生成";
  toast("辅助图已生成：边界概率、包络、相位、瞬时频率和相干性可切换查看");
}

async function importAutoHorizonsToManual() {
  const ds = currentDisplayed();
  if (!ds) return toast("请先导入数据", "warn");
  if (!geologyResult) geologyResult = await runWorker("geology-model", ds, collectGeoParams(ds));
  const st = ensureManualState();
  pushManualHistory();
  const stride = Math.max(1, Math.floor(ds.numTraces / 180));
  for (const h of geologyResult.horizons || []) {
    const layer = { id: `A${Date.now().toString(36)}${Math.floor(Math.random() * 999)}`, name: `${h.name}-auto`, color: manualLayerColors[st.layers.length % manualLayerColors.length], type: "horizon", points: [], visible: true, locked: false, source: "auto", confidence: h.meanConfidence || 70, metadata: { importedFromAuto: true } };
    for (let t = 0; t < ds.numTraces; t += stride) {
      const sampleIndex = Math.max(0, Math.min(ds.numSamples - 1, Math.round((h.line[t] || 0) / manualDepthStep(ds))));
      layer.points.push(enrichManualPoint({ traceIndex: t, sampleIndex, source: "auto", snapScore: (h.confidence?.[t] || 0) / 100 }, ds));
    }
    st.layers.push(layer);
    st.activeLayerId = layer.id;
  }
  drawManualWorkbench();
  toast("自动层位已作为建议线导入，人工编辑优先级更高");
}

function manualAutoTraceFromSeed(seed) {
  const ds = currentDisplayed();
  const prob = manualFeatureResult?.boundaryProbability || manualFeatureResult?.data;
  if (!ds || !prob?.length) return toast("请先计算辅助图", "warn");
  const layer = createManualLayer("snapped");
  layer.name = `Seed ${layer.name}`;
  const win = Math.max(8, Math.round(0.5 / manualDepthStep(ds)));
  for (const dir of [-1, 1]) {
    let sample = seed.sampleIndex;
    const pts = [];
    for (let t = seed.traceIndex; t >= 0 && t < ds.numTraces; t += dir) {
      let bestS = sample, best = -Infinity;
      for (let s = Math.max(0, sample - win); s <= Math.min(ds.numSamples - 1, sample + win); s++) {
        const v = prob[t * ds.numSamples + s] - Math.abs(s - sample) / Math.max(1, win) * 0.08;
        if (v > best) { best = v; bestS = s; }
      }
      sample = bestS;
      pts.push(enrichManualPoint({ traceIndex: t, sampleIndex: bestS, source: "snapped", snapScore: best }, ds));
    }
    if (dir < 0) layer.points.push(...pts.reverse());
    else layer.points.push(...pts.slice(1));
  }
  sortLayerPoints(layer);
  drawManualWorkbench();
}

function lineFromManualLayer(layer, ds) {
  const line = new Float32Array(ds.numTraces), valid = new Uint8Array(ds.numTraces);
  line.fill(NaN);
  const pts = layer.points.slice().sort((a, b) => a.traceIndex - b.traceIndex);
  const maxGap = Math.max(8, Math.round(ds.numTraces * 0.05));
  for (const p of pts) { line[p.traceIndex] = p.depthM; valid[p.traceIndex] = 1; }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1], gap = b.traceIndex - a.traceIndex;
    if (gap <= 1 || gap > maxGap) continue;
    for (let t = a.traceIndex + 1; t < b.traceIndex; t++) {
      const f = (t - a.traceIndex) / gap;
      line[t] = a.depthM + (b.depthM - a.depthM) * f;
      valid[t] = 2;
    }
  }
  const finite = Array.from(line).filter(Number.isFinite);
  const stats = finite.length ? lineDepthStats(Float32Array.from(finite)) : { meanDepth: 0, medianDepth: 0, minDepth: 0, maxDepth: 0 };
  const confidence = new Float32Array(ds.numTraces);
  for (let t = 0; t < ds.numTraces; t++) confidence[t] = valid[t] === 1 ? 100 : valid[t] === 2 ? 72 : 0;
  return { ...layer, ...stats, line, valid, confidence, meanConfidence: finiteMean(confidence), source: layer.source || "manual" };
}

function generateManualModel() {
  const ds = currentDisplayed();
  if (!ds) return toast("请先导入数据", "warn");
  const st = ensureManualState();
  const usable = st.layers.filter(l => l.visible && l.points.length >= 2);
  if (!usable.length) return toast("请先手动画出至少一条层位线", "warn");
  const horizons = usable.map(l => lineFromManualLayer(l, ds)).sort((a, b) => a.medianDepth - b.medianDepth);
  const rp = getEffectiveRadarParams(ds), modelSamples = 480, depthMax = finiteNumber($("#geo-depth")?.value, rp.depthMaxM);
  const modelData = new Uint8Array(modelSamples * ds.numTraces), uncertaintyData = new Uint8Array(modelSamples * ds.numTraces);
  for (let z = 0; z < modelSamples; z++) {
    const depth = z / Math.max(1, modelSamples - 1) * depthMax;
    for (let t = 0; t < ds.numTraces; t++) {
      let layer = 0, unknown = false;
      for (const h of horizons) {
        if (!Number.isFinite(h.line[t])) { unknown = true; continue; }
        if (depth >= h.line[t]) layer++;
      }
      const idx = z * ds.numTraces + t;
      modelData[idx] = unknown ? 255 : Math.min(layer, GEO_LABELS_SAFE.length - 1);
      uncertaintyData[idx] = unknown ? 100 : 0;
    }
  }
  manualModelResult = { data: ds.data, numTraces: ds.numTraces, numSamples: ds.numSamples, modelData, uncertaintyData, modelTraces: ds.numTraces, modelSamples, modelDepthMax: depthMax, depthStep: depthMax / Math.max(1, modelSamples - 1), distanceStep: rp.dxM, velocity: rp.velocityMPerNs, epsilonR: rp.epsilonR, horizons, layerNames: GEO_LABELS_SAFE, source: "manual" };
  drawManualWorkbench();
  $("#manual-geo-report").innerHTML = `<b>Manual model generated 手动模型已生成</b><p>${horizons.length} 条人工层位；人工线优先，短缺口已插值，长缺口标为未解释。</p>`;
  toast("手动地质模型已生成");
}

function saveManualGeoOutput() {
  const result = manualModelResult;
  if (!result) return toast("请先生成手动地质模型", "warn");
  const ds = currentDisplayed();
  store.setOutput({
    data: result.data,
    numTraces: result.numTraces,
    numSamples: result.numSamples,
    name: `${ds?.name || "data"}_manual_geology_model`,
    meta: result.meta || ds?.meta,
    dtNs: result.dtNs,
    dxM: result.dxM,
    depthStep: result.depthStep,
    depthAxisM: result.meta?.depthAxisM,
    modelData: result.modelData,
    uncertaintyData: result.uncertaintyData,
    horizons: result.horizons
  }, { name: "手动地质解释模型", op: "manual-geo-model", params: collectGeoParams(ds) });
  displaySource = "output";
  $("#display-mode").value = "output";
  toast("手动地质模型已保存到 Output Data");
}

function manualReportPayload() {
  const ds = currentDisplayed();
  const st = ensureManualState();
  const rp = getEffectiveRadarParams(ds);
  return {
    createdAt: new Date().toISOString(),
    dataset: {
      name: ds?.name || "data",
      sourceFormat: ds?.meta?.sourceFormat || "",
      numTraces: ds?.numTraces || 0,
      numSamples: ds?.numSamples || 0
    },
    radarParams: {
      dtNs: rp.dtNs,
      dxM: sanitizeDistanceStep(rp.dxM, ds?.numTraces || 0),
      velocityMPerNs: rp.velocityMPerNs,
      epsilonR: rp.epsilonR,
      depthMaxM: rp.depthMaxM,
      vofhText: rp.vofhText
    },
    layers: st.layers.map(layer => ({
      id: layer.id,
      name: layer.name,
      color: layer.color,
      source: layer.source,
      visible: layer.visible,
      locked: layer.locked,
      confidence: layer.confidence,
      pointCount: layer.points.length,
      depthRangeM: layer.points.length ? [Math.min(...layer.points.map(p => p.depthM || 0)), Math.max(...layer.points.map(p => p.depthM || 0))] : [0, 0],
      points: layer.points.map(p => ({ traceIndex: p.traceIndex, sampleIndex: p.sampleIndex, depthM: p.depthM, distanceM: p.distanceM, source: p.source, snapScore: p.snapScore }))
    })),
    model: manualModelResult ? {
      source: manualModelResult.source || "manual",
      modelTraces: manualModelResult.modelTraces,
      modelSamples: manualModelResult.modelSamples,
      modelDepthMax: manualModelResult.modelDepthMax,
      horizonCount: manualModelResult.horizons?.length || 0
    } : null,
    notes: "Manual horizons have priority over snapped, auto, and interpolated segments."
  };
}

function renderManualProfileExportCanvas(width = 1600, height = 900) {
  const ds = currentDisplayed(), viewDs = manualDisplayDataset();
  if (!ds || !viewDs) return null;
  const st = ensureManualState(), view = ensureManualView(ds);
  const rp = getEffectiveRadarParams(ds);
  const canvas = document.createElement("canvas");
  const render = renderDatasetCanvas(canvas, viewDs, {
    width,
    height,
    pixelRatio: 2,
    cmap: view.cmap,
    min: view.min,
    max: view.max,
    axes: true,
    colorbar: true,
    traceStart: view.traceStart,
    traceEnd: view.traceEnd,
    sampleStart: view.sampleStart,
    sampleEnd: view.sampleEnd,
    depthMax: manualSampleMax(ds) * manualDepthStep(ds),
    sampleMax: manualSampleMax(ds),
    distanceStep: rp.dxM,
    horizons: ($("#manual-display-mode")?.value || st.displayMode) === "auto" ? geologyResult?.horizons || [] : []
  });
  drawManualLayersOnRender(render, st.layers, st.activeLayerId);
  return canvas;
}

function renderManualModelExportCanvas(width = 1600, height = 900) {
  if (!manualModelResult) return null;
  const canvas = document.createElement("canvas");
  drawLayerModelCanvas(canvas, manualModelResult, { width, height, pixelRatio: 2 });
  return canvas;
}

function downloadCanvasPng(canvas, name) {
  if (!canvas) return;
  canvas.toBlob(blob => blob && download(blob, name));
}

function ensureManualExportDialog() {
  let dlg = $("#manual-export-dialog");
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.id = "manual-export-dialog";
  dlg.className = "geo-export-dialog";
  dlg.innerHTML = '<form method="dialog"><h2>Export Manual Interpretation</h2><div class="export-option-group"><h4>Format</h4><label><input type="radio" name="manual-export-format" value="json"> JSON structure</label><label><input type="radio" name="manual-export-format" value="png" checked> PNG images</label><label><input type="radio" name="manual-export-format" value="html"> HTML report</label><label><input type="radio" name="manual-export-format" value="pdf"> PDF via print</label></div><label>Title<input id="manual-export-title" value="Manual Interpretation Report"></label><menu><button value="cancel">Cancel</button><button value="default" class="primary">Export</button></menu></form>';
  document.body.appendChild(dlg);
  return dlg;
}

function openManualExport() {
  const ds = currentDisplayed();
  if (!ds) return toast("请先导入数据", "warn");
  const dlg = ensureManualExportDialog();
  dlg.onclose = function() {
    if (dlg.returnValue !== "default") return;
    const format = dlg.querySelector("input[name='manual-export-format']:checked")?.value || "png";
    const title = $("#manual-export-title")?.value || "Manual Interpretation Report";
    exportManualReport(format, title);
  };
  dlg.showModal();
}

function exportManualReport(format, title) {
  const payload = manualReportPayload();
  const base = (payload.dataset.name || "manual-interpretation").replace(/\.\w+$/i, "").replace(/[^\w.-]+/g, "_");
  if (format === "json") {
    download(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), `${base}_manual_interpretation.json`);
    return;
  }
  const profileCanvas = renderManualProfileExportCanvas();
  const modelCanvas = renderManualModelExportCanvas();
  if (format === "png") {
    downloadCanvasPng(profileCanvas, `${base}_manual_profile.png`);
    if (modelCanvas) downloadCanvasPng(modelCanvas, `${base}_manual_model.png`);
    else toast("已导出剖面图；尚未生成手动模型图", "warn");
    return;
  }
  const profileUrl = profileCanvas?.toDataURL("image/png") || "";
  const modelUrl = modelCanvas?.toDataURL("image/png") || "";
  const layerRows = payload.layers.map(l => `<tr><td>${escapeHtml(l.name)}</td><td>${escapeHtml(l.source || "")}</td><td>${l.pointCount}</td><td>${axisNumber(l.depthRangeM[0])}-${axisNumber(l.depthRangeM[1])} m</td><td>${escapeHtml(l.color)}</td></tr>`).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:Arial,sans-serif;margin:24px;color:#1a1a1a}h1{font-size:20px;border-bottom:2px solid #2563eb;padding-bottom:8px}.kpis{display:flex;flex-wrap:wrap;gap:12px;margin:12px 0}.kpis span{border:1px solid #d1d5db;border-radius:6px;padding:6px 10px;background:#f8fafc}img{max-width:100%;border:1px solid #d1d5db;margin:10px 0 18px}table{width:100%;border-collapse:collapse;margin:12px 0;font-size:12px}th,td{border:1px solid #d1d5db;padding:6px 8px;text-align:left}th{background:#f3f4f6}.muted{color:#667085}</style></head><body><h1>${escapeHtml(title)}</h1><div class="kpis"><span>${escapeHtml(payload.dataset.name)}</span><span>${payload.dataset.numTraces} traces</span><span>${payload.dataset.numSamples} samples</span><span>dt ${axisNumber(payload.radarParams.dtNs)} ns</span><span>dx ${Number.isFinite(payload.radarParams.dxM) ? axisNumber(payload.radarParams.dxM) + " m" : "trace axis"}</span><span>v ${axisNumber(payload.radarParams.velocityMPerNs)} m/ns</span></div><h2>Radar Profile with Manual Horizons</h2><img src="${profileUrl}">${modelUrl ? `<h2>Manual Geologic Model</h2><img src="${modelUrl}">` : `<p class="muted">Manual model has not been generated yet.</p>`}<h2>Horizon Layers</h2><table><thead><tr><th>Name</th><th>Source</th><th>Points</th><th>Depth range</th><th>Color</th></tr></thead><tbody>${layerRows || "<tr><td colspan='5'>No manual horizons.</td></tr>"}</tbody></table><p class="muted">${escapeHtml(payload.notes)}</p><script>${format === "pdf" ? "print()" : ""}<\/script></body></html>`;
  if (format === "pdf") {
    const win = window.open("", "_blank");
    if (win) { win.document.write(html); win.document.close(); toast("Print dialog opened - save as PDF"); }
    else { download(new Blob([html], { type: "text/html" }), `${base}_manual_report.html`); toast("Popup blocked - exported HTML instead", "warn"); }
  } else {
    download(new Blob([html], { type: "text/html" }), `${base}_manual_report.html`);
  }
}

function drawGeologyResult() {
  if (!geologyResult) return;
  renderDatasetCanvas($("#geo-radar-canvas"), { data: geologyResult.data, numTraces: geologyResult.numTraces, numSamples: geologyResult.numSamples }, {
    cmap: "seismic", min: -2.2, max: 2.2, horizons: geologyResult.horizons, modelDepthMax: geologyResult.modelDepthMax, depthMax: geologyResult.modelDepthMax, distanceStep: geologyResult.distanceStep || geologyResult.dx, axes: true, sampleMax: Math.ceil(geologyResult.modelDepthMax / geologyResult.depthStep)
  });
  drawLayerModelCanvas($("#geo-model-canvas"), geologyResult);
  const qr = geologyResult.qualityReport || {};
  const rows = geologyResult.horizons.map(h => `<tr><td>${h.name}</td><td>${h.medianDepth.toFixed(2)} m</td><td>${h.minDepth.toFixed(2)}-${h.maxDepth.toFixed(2)} m</td><td>${(h.meanConfidence ?? 0).toFixed(0)}%</td><td>${((h.coverage ?? 0) * 100).toFixed(0)}%</td><td>${escapeHtml((h.warnings || []).join("; ") || "OK")}</td></tr>`).join("");
  const lowRanges = (qr.lowConfidenceRanges || []).slice(0, 6).map(r => `${r.horizon}:${r.startTrace}-${r.endTrace}`).join("；") || "无";
  $("#geo-report").innerHTML = `<div class="geo-kpis"><span>速度 ${geologyResult.velocity.toFixed(3)} m/ns</span><span>εr ${geologyResult.epsilonR.toFixed(2)}</span><span>质量 ${Number(qr.score || 0).toFixed(0)}/${qr.threshold || 70} · ${qr.status || "review"}</span><span>${geologyResult.autoMode || "conservative"}</span></div><p class="muted">低置信区间：${escapeHtml(lowRanges)}</p><table class="mini-table"><thead><tr><th>界面</th><th>中值深度</th><th>范围</th><th>置信度</th><th>覆盖率</th><th>提示</th></tr></thead><tbody>${rows}</tbody></table>`;
}
function horizonDepthAtCanvasX(hzn, x, width) {
  const line = hzn.line || [];
  if (!line.length) return 0;
  if (line.length === 1 || width <= 1) return Number.isFinite(line[0]) ? line[0] : 0;
  const pos = x / (width - 1) * (line.length - 1);
  const i = Math.floor(pos), j = Math.min(line.length - 1, i + 1), f = pos - i;
  const a = line[i], b = line[j];
  if (Number.isFinite(a) && Number.isFinite(b)) return a + (b - a) * f;
  if (Number.isFinite(a)) return a;
  if (Number.isFinite(b)) return b;
  for (let r = 1; r < line.length; r++) {
    const left = i - r, right = i + r;
    if (left >= 0 && Number.isFinite(line[left])) return line[left];
    if (right < line.length && Number.isFinite(line[right])) return line[right];
  }
  return 0;
}
function horizonFiniteDepthAtCanvasX(hzn, x, width) {
  const line = hzn.line || [];
  if (!line.length) return NaN;
  if (line.length === 1 || width <= 1) return Number.isFinite(line[0]) ? line[0] : NaN;
  const pos = x / (width - 1) * (line.length - 1);
  const i = Math.floor(pos), j = Math.min(line.length - 1, i + 1), f = pos - i;
  const a = line[i], b = line[j];
  if (Number.isFinite(a) && Number.isFinite(b)) return a + (b - a) * f;
  return Number.isFinite(a) ? a : (Number.isFinite(b) ? b : NaN);
}
function paintImagePoint(img, w, h, x, y, rgb, radius = 0) {
  for (let oy = -radius; oy <= radius; oy++) for (let ox = -radius; ox <= radius; ox++) {
    const xx = x + ox, yy = y + oy;
    if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
    const i = (yy * w + xx) * 4;
    img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2]; img.data[i + 3] = 255;
  }
}
function paintImageLine(img, w, h, x0, y0, x1, y1, rgb, radius = 0) {
  let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    paintImagePoint(img, w, h, x0, y0, rgb, radius);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}
function drawLayerModelCanvas(canvas, result, opts = {}) {
  if (!canvas || !result) return;
  const prepared = setupCanvas(canvas, { axes: true, ...opts });
  const traceCount = Math.max(1, result.modelTraces || result.numTraces || 1);
  const depthMax = Math.max(1e-9, Number(result.modelDepthMax || 1));
  const layout = plotLayout(prepared.cssW, prepared.cssH, { axes: true, ...opts });
  const scale = {
    traces: traceCount,
    samples: result.modelSamples || result.numSamples || 1,
    sampleMax: result.modelSamples || result.numSamples || 1,
    traceStart: 0,
    traceEnd: Math.max(1, traceCount - 1),
    sampleStart: 0,
    sampleEnd: result.modelSamples || result.numSamples || 1,
    depthMax,
    depthStep: result.depthStep || depthMax / Math.max(1, (result.modelSamples || result.numSamples || 1) - 1),
    depthStart: 0,
    depthEnd: depthMax,
    distanceStep: sanitizeDistanceStep(result.distanceStep ?? result.dxM ?? result.dx, traceCount),
    layout
  };
  const render = { ...prepared, layout, scale };
  const { ctx } = render, { plot } = layout;
  const palette = [[234,215,183],[214,191,130],[183,193,138],[143,182,161],[120,149,178],[111,116,132],[68,72,87]];
  ctx.fillStyle = "#080c14";
  ctx.fillRect(0, 0, prepared.cssW, prepared.cssH);
  const plotW = Math.max(1, Math.floor(plot.w)), plotH = Math.max(1, Math.floor(plot.h));
  const off = document.createElement("canvas");
  off.width = plotW; off.height = plotH;
  const offCtx = off.getContext("2d");
  const img = offCtx.createImageData(plotW, plotH);
  const hzns = result.horizons || [];
  const hasModel = result.modelData?.length && result.modelTraces && result.modelSamples;
  for (let y = 0; y < plotH; y++) {
    const depth = y / (plotH - 1 || 1) * depthMax;
    for (let x = 0; x < plotW; x++) {
      let c;
      if (hasModel) {
        const trace = Math.min(result.modelTraces - 1, Math.floor(x / Math.max(1, plotW) * result.modelTraces));
        const z = Math.min(result.modelSamples - 1, Math.floor(y / Math.max(1, plotH) * result.modelSamples));
        const layer = result.modelData[z * result.modelTraces + trace];
        c = layer === 255 ? [42, 48, 58] : palette[Math.min(layer, palette.length - 1)];
      } else {
        let layer = 0;
        for (const hzn of hzns) if (depth >= horizonDepthAtTrace(hzn, x / Math.max(1, plotW - 1) * (traceCount - 1), traceCount)) layer++;
        c = palette[Math.min(layer, palette.length - 1)];
      }
      const i = (y * plotW + x) * 4;
      img.data[i] = c[0]; img.data[i+1] = c[1]; img.data[i+2] = c[2]; img.data[i+3] = 255;
    }
  }
  offCtx.putImageData(img, 0, 0);
  ctx.drawImage(off, plot.x, plot.y, plot.w, plot.h);
  ctx.save();
  ctx.beginPath(); ctx.rect(plot.x, plot.y, plot.w, plot.h); ctx.clip();
  ctx.lineWidth = opts.lineWidth || 1.4;
  ctx.strokeStyle = "rgba(12,18,30,.92)";
  for (const hzn of hzns) {
    let started = false;
    ctx.beginPath();
    for (let x = 0; x <= plotW; x++) {
      const trace = x / Math.max(1, plotW) * (traceCount - 1);
      const depth = horizonDepthAtTrace(hzn, trace, traceCount);
      if (!Number.isFinite(depth)) { started = false; continue; }
      const px = plot.x + x / Math.max(1, plotW) * plot.w;
      const y = depthToPlotY(depth, render);
      if (y < plot.y - 3 || y > plot.y + plot.h + 3) { started = false; continue; }
      started ? ctx.lineTo(px, y) : ctx.moveTo(px, y);
      started = true;
    }
    ctx.stroke();
  }
  ctx.restore();
  drawPlotAxes(ctx, render, { axes: true });
  return render;
}
function exportGeologyJson() {
  if (!geologyResult) return toast("请先生成自动地质模型", "warn");
  const compact = {
    ...geologyResult,
    data: undefined,
    modelData: Array.from(geologyResult.modelData),
    horizons: geologyResult.horizons.map(h => ({ ...h, line: Array.from(h.line) }))
  };
  download(new Blob([JSON.stringify(compact, null, 2)], { type: "application/json" }), "geologic-model.json");
}

function ensureGeoExportDialog() {
  let dlg = $("#geo-export-dialog");
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.id = "geo-export-dialog";
  dlg.className = "geo-export-dialog";
  dlg.innerHTML = '<form method="dialog"><h2>Export Geology Model Image</h2><div class="export-option-group"><h4>Format</h4><label><input type="radio" name="geo-export-format" value="png" checked> PNG</label><label><input type="radio" name="geo-export-format" value="pdf"> PDF (with report)</label></div><div class="export-option-group"><h4>Options</h4><label><input type="checkbox" id="geo-export-lines" checked> Show horizon lines</label></div><div id="geo-export-pdf-opts" style="display:none"><label>Title<input id="geo-export-title" value="Geologic Model"></label></div><menu><button value="cancel">Cancel</button><button id="geo-export-run" value="default" class="primary">Export</button></menu></form>';
  document.body.appendChild(dlg);
  dlg.querySelector("input[name='geo-export-format'][value='pdf']").onchange = function() { $("#geo-export-pdf-opts").style.display = "block"; };
  dlg.querySelector("input[name='geo-export-format'][value='png']").onchange = function() { $("#geo-export-pdf-opts").style.display = "none"; };
  return dlg;
}

function openGeoExport() {
  if (!geologyResult) return toast("Please run geology model first", "warn");
  const dlg = ensureGeoExportDialog();
  dlg.onclose = function() {
    if (dlg.returnValue !== "default") return;
    const format = dlg.querySelector("input[name='geo-export-format']:checked")?.value || "png";
    const showLines = $("#geo-export-lines")?.checked !== false;
    const title = $("#geo-export-title")?.value || "Geologic Model";
    exportGeoImage(format, showLines, title);
  };
  dlg.showModal();
}

function exportGeoImage(format, showLines, title) {
  const result = geologyResult;
  const traceCount = result.numTraces || result.modelTraces || 1;
  const width = Math.min(1800, Math.max(900, traceCount));
  const height = 1000;
  const canvas = document.createElement("canvas");
  const exportResult = showLines ? result : { ...result, horizons: [] };
  drawLayerModelCanvas(canvas, exportResult, { width, height, pixelRatio: 2 });
  const depthMax = result.modelDepthMax || 1;
  if (format === "pdf") {
    const dataUrl = canvas.toDataURL("image/png");
    const hzns = result.horizons || [];
    const rows = hzns.map(h => `<tr><td>${escapeHtml(h.name || "")}</td><td>${axisNumber(h.medianDepth)} m</td><td>${axisNumber(h.minDepth)}-${axisNumber(h.maxDepth)} m</td><td>${escapeHtml(h.layerName || "")}</td><td>${escapeHtml(h.meaning || "")}</td></tr>`).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:Arial,sans-serif;margin:24px;color:#1a1a1a}h1{font-size:18px;border-bottom:2px solid #2563eb;padding-bottom:8px}table{width:100%;border-collapse:collapse;margin:16px 0;font-size:12px}th,td{border:1px solid #d1d5db;padding:6px 10px}th{background:#f3f4f6}.kpis{display:flex;flex-wrap:wrap;gap:14px;margin:10px 0;font-size:13px}img{max-width:100%;border:1px solid #d1d5db}</style></head><body><h1>${escapeHtml(title)}</h1><div class="kpis"><span>Velocity ${axisNumber(result.velocity)} m/ns</span><span>eps-r ${axisNumber(result.epsilonR || 9)}</span><span>Depth 0-${axisNumber(depthMax)} m</span><span>${traceCount} traces</span></div><img src="${dataUrl}"><h2>Horizon Interpretation</h2><table><thead><tr><th>Horizon</th><th>Median Depth</th><th>Range</th><th>Layer</th><th>Meaning</th></tr></thead><tbody>${rows}</tbody></table><script>print()<\/script></body></html>`;
    const win = window.open("", "_blank");
    if (win) { win.document.write(html); win.document.close(); toast("Print dialog opened - save as PDF"); }
    else { download(new Blob([html], { type: "text/html" }), `${title}.html`); toast("Popup blocked - exported HTML instead", "warn"); }
  } else {
    canvas.toBlob(blob => blob && download(blob, `${title}.png`));
  }
}

function syncExportControls(ds = currentDisplayed()) {
  if (!ds) return;
  const rp = getEffectiveRadarParams(ds);
  if ($("#export-dt")) $("#export-dt").value = (rp.dtNs / 1000).toFixed(6);
  if ($("#export-dzt-dt")) $("#export-dzt-dt").value = rp.dtNs.toFixed(4);
  if ($("#export-dx")) $("#export-dx").value = rp.dxM.toFixed(4);
  if ($("#export-range")) $("#export-range").value = (ds.numSamples * rp.dtNs).toFixed(2);
}

function exportData(kind) {
  const ds = $("#export-source").value === "output" && store.output ? store.output : store.current;
  if (!ds) return toast("无可导出数据", "warn");
  const rp = getEffectiveRadarParams(ds);
  try {
    if (kind === "2b") download(write2BFile(ds), dataFileName(ds.name));
    else if (kind === "mgp") download(writeMgpJson(store.ipd), `${store.ipd.name}.mgp.json`);
    else if (kind === "depth") download(writeMgpJson({ ...store.ipd, current: ds }), `${store.ipd.name}_depth.json`);
    else if (kind === "segy") download(writeSEGYFile(ds, Number($("#export-dt")?.value || rp.dtNs / 1000), Number($("#export-dx")?.value || rp.dxM)), `${(ds.name || "data").replace(/\.\w+$/i, "")}.sgy`);
    else if (kind === "dzt") download(writeDZTFile(ds, Number($("#export-dzt-dt")?.value || rp.dtNs), Number($("#export-dx")?.value || rp.dxM), Number($("#export-range")?.value || ds.numSamples * rp.dtNs)), `${(ds.name || "data").replace(/\.\w+$/i, "")}.dzt`);
    else if (kind === "su") download(writeSEGYLike(ds, "su"), `${ds.name || "data"}.su`);
    else if (kind === "csv") download(exportCsv(ds), `${(ds.name || "data").replace(/\.\w+$/i, "")}.csv`);
    else if (kind === "bin") download(new Blob([ds.data.buffer], { type: "application/octet-stream" }), `${(ds.name || "data").replace(/\.\w+$/i, "")}.bin`);
    else if (kind === "png") exportPng(ds, `${(ds.name || "radar").replace(/\.\w+$/i, "")}.png`);
    else if (kind === "pdf") exportPdfDocument(ds, `${(ds.name || "radar").replace(/\.\w+$/i, "")}.pdf`);
    toast("导出完成");
  } catch (e) { toast(e.message, "err"); }
}

function bindUi() {
  $("#file-input").onchange = e => importFiles(e.target.files);
  $("#drop-zone").onclick = () => $("#file-input").click();
  $("#drop-zone").ondragover = e => { e.preventDefault(); $("#drop-zone").classList.add("over"); };
  $("#drop-zone").ondragleave = () => $("#drop-zone").classList.remove("over");
  $("#drop-zone").ondrop = e => { e.preventDefault(); $("#drop-zone").classList.remove("over"); importFiles(e.dataTransfer.files); };
  document.body.addEventListener("click", e => {
    const action = e.target.dataset.action, page = e.target.dataset.page, proc = e.target.dataset.process, exp = e.target.dataset.export;
    const toolBtn = e.target.closest?.("[data-manual-tool]");
    const layerBtn = e.target.closest?.("[data-manual-layer]");
    const visibleBtn = e.target.closest?.("[data-manual-visible]");
    const deleteBtn = e.target.closest?.("[data-manual-delete]");
    if (e.target.dataset.dataSelect) {
      e.target.checked ? dataManagerSelection.add(e.target.dataset.dataSelect) : dataManagerSelection.delete(e.target.dataset.dataSelect);
      renderDataManager();
    }
    if (e.target.dataset.dataUse) useManagedDataset(e.target.dataset.dataUse);
    if (e.target.dataset.sideUse) useManagedDataset(e.target.dataset.sideUse);
    if (e.target.dataset.dataRename) renameManagedDataset(e.target.dataset.dataRename);
    if (e.target.dataset.dataExport) exportManagedDataset(e.target.dataset.dataExport);
    if (e.target.dataset.geoStep) runGeoPipelineStep(e.target.dataset.geoStep);
    if (toolBtn) {
      manualGeoTool = toolBtn.dataset.manualTool;
      $$("[data-manual-tool]").forEach(b => b.classList.toggle("active", b === toolBtn));
      toast(`手动工具：${toolBtn.textContent.trim()}`);
    }
    if (layerBtn) { ensureManualState().activeLayerId = layerBtn.dataset.manualLayer; renderManualLayerList(); drawManualWorkbench(); }
    if (visibleBtn) {
      const st = ensureManualState(), layer = st.layers.find(l => l.id === visibleBtn.dataset.manualVisible);
      if (layer) { layer.visible = !layer.visible; renderManualLayerList(); drawManualWorkbench(); }
    }
    if (deleteBtn) {
      const st = ensureManualState();
      pushManualHistory();
      st.layers = st.layers.filter(l => l.id !== deleteBtn.dataset.manualDelete);
      if (!st.layers.some(l => l.id === st.activeLayerId)) st.activeLayerId = st.layers[0]?.id || "";
      drawManualWorkbench();
    }
    if (page) switchPage(page);
    if (proc) openProcess(proc);
    if (exp) exportData(exp);
    if (e.target.dataset.radarMode) setRadarMode(e.target.dataset.radarMode);
    if (e.target.dataset.popup) toggleFloat(e.target.dataset.popup);
    if (e.target.dataset.selectionExtract) extractSelections(Number(e.target.dataset.selectionExtract));
    if (e.target.dataset.selectionZoom) radar.zoomToSelection(radarSelections[Number(e.target.dataset.selectionZoom)]);
    if (e.target.dataset.selectionRemove) { radarSelections.splice(Number(e.target.dataset.selectionRemove), 1); updateSelectionPanel(); }
    if (e.target.dataset.annotationRemove) { radarAnnotations.splice(Number(e.target.dataset.annotationRemove), 1); updateAnnotationPanel(); }
    if (action === "open-import") $("#file-input").click();
    if (action === "zoom-in") radar.zoomIn();
    if (action === "zoom-out") radar.zoomOut();
    if (action === "zoom-fit" || action === "radar-reset") radar.zoomFit();
    if (action === "toggle-depth-axis") { depthAxisEnabled = !depthAxisEnabled; applyDepthAxisMode(); toast(depthAxisEnabled ? "纵轴已切换为深度" : "纵轴已恢复为采样点/时间"); }
    if (action === "selection-extract") extractSelections();
    if (action === "selection-clear") clearSelections();
    if (action === "selection-export-2b") exportSelection("2b");
    if (action === "selection-export-pdf") exportSelection("pdf");
    if (action === "data-merge-export") mergeSelectedManagedDatasets();
    if (action === "data-delete-selected") deleteSelectedManagedDatasets();
    if (action === "data-clear-selection") { dataManagerSelection.clear(); renderDataManager(); }
    if (action === "open-radar-params") openRadarParamsDialog();
    if (action === "annotation-export") download(new Blob([JSON.stringify(radarAnnotations, null, 2)], { type: "application/json" }), "annotations.json");
    if (action === "annotation-clear") { radarAnnotations = []; updateAnnotationPanel(); }
    if (action === "run-geology") runGeologyModel();
    if (action === "export-geology") exportGeologyJson();
    if (action === "export-geo-image") openGeoExport();
    if (action === "manual-new-layer") { createManualLayer("manual"); drawManualWorkbench(); }
    if (action === "manual-compute-aids") computeManualAids();
    if (action === "manual-import-auto") importAutoHorizonsToManual();
    if (action === "manual-undo") {
      const st = ensureManualState();
      if (st.history.length) { st.future.push(cloneManualLayers(st.layers)); st.layers = st.history.pop(); st.activeLayerId = st.layers[0]?.id || ""; drawManualWorkbench(); }
    }
    if (action === "manual-redo") {
      const st = ensureManualState();
      if (st.future.length) { st.history.push(cloneManualLayers(st.layers)); st.layers = st.future.pop(); st.activeLayerId = st.layers[0]?.id || ""; drawManualWorkbench(); }
    }
    if (action === "manual-generate-model") generateManualModel();
    if (action === "manual-geo-save") saveManualGeoOutput();
    if (action === "manual-auto-range") setManualAutoRange();
    if (action === "manual-reset-view") resetManualView();
    if (action === "manual-export-report") openManualExport();
    if (action === "open-trace") openFloat("trace-window");
    if (action === "open-spectrum") openFloat("spectrum-window");
    if (action === "hold-output") store.holdOutput() ? toast("Output Data 已接受为 Current Input Data") : toast("没有 Output Data", "warn");
    if (action === "discard-output") store.discardOutput() ? toast("Output Data 已丢弃") : toast("没有 Output Data", "warn");
    if (action === "open-undo") openUndo();
    if (action === "save-mgp") exportData("mgp");
    if (action === "save-depth") exportData("depth");
    if (action === "show-instant") openProcess("instantaneous");
    if (action === "show-centroid") computeSpecial("centroid", "质心频率");
    if (action === "show-attenuation") computeAttenuation();
    if (action === "show-algorithm-help") showAlgorithmHelp();
    if (action === "velocity-calc") simpleVelocityCalc();
    if (action === "velocity-1d") toast("1-D velocity model 已使用速度点表作为第一版模型。", "warn");
    if (action === "velocity-2d") toast("2-D velocity model 可由 Model Builder 生成。", "warn");
    if (action === "forward") forwardModel();
    if (action === "make-xyz") toast("Make XYZ 已建立入口：第一版使用 .2B 位置元数据或手动测线间距。", "warn");
    if (action === "create-3d") create3D();
    if (action === "save-report") download(new Blob([JSON.stringify({ velocityPoints, model }, null, 2)], {type:"application/json"}), "interpretation-report.json");
    if (e.target.dataset.close) $(`#${e.target.dataset.close}`).classList.remove("show");
    if (e.target.dataset.modelTool) { modelTool = e.target.dataset.modelTool; toast(`建模工具：${modelTool}`); }
  });
  $("#display-mode").onchange = e => { displaySource = e.target.value; refresh(); syncExportControls(); };
  $("#export-source") && ($("#export-source").onchange = () => syncExportControls());
  $("#geo-dt")?.addEventListener("input", () => updateGeoDepthFromControls());
  $("#geo-velocity")?.addEventListener("input", () => updateGeoDepthFromControls());
  $("#geo-depth")?.addEventListener("input", () => { $("#geo-depth").dataset.manual = "true"; });
  $("#manual-display-mode")?.addEventListener("change", () => drawManualWorkbench());
  $("#manual-cmap")?.addEventListener("change", readManualViewControls);
  $("#manual-min")?.addEventListener("change", readManualViewControls);
  $("#manual-max")?.addEventListener("change", readManualViewControls);
  $("#manual-snap")?.addEventListener("change", e => { ensureManualState().snapEnabled = e.target.checked; });
  $("#colormap").onchange = e => radar.setColormap(e.target.value);
  $("#amp-min").onchange = () => radar.setAmp(Number($("#amp-min").value), Number($("#amp-max").value));
  $("#amp-max").onchange = () => radar.setAmp(Number($("#amp-min").value), Number($("#amp-max").value));
  $("#trace-index").onchange = () => syncTraceIndex(Number($("#trace-index").value));
  $("#spectrum-index").onchange = () => { radar.setCurrentTrace(Number($("#spectrum-index").value)); drawSpectrum(); };
  $("#spectrum-mean").onclick = () => drawSpectrum(true);
  bindLongPress("[data-trace-step]", btn => moveTrace(Number(btn.dataset.traceStep)));
  bindLongPress("[data-spectrum-step]", btn => { $("#spectrum-index").value = Math.max(0, Number($("#spectrum-index").value) + Number(btn.dataset.spectrumStep)); drawSpectrum(); radar.setCurrentTrace(Number($("#spectrum-index").value)); });
  makeDraggable($("#trace-window")); makeDraggable($("#spectrum-window")); makeDraggable($("#selection-window")); makeDraggable($("#annotation-window")); makeDraggable($("#toolbar-process-window"));
  $("#save-velocity").onclick = () => {
    const p = { v: Number($("#vel-v").value), x0: Number($("#vel-x0").value), z0: Number($("#vel-z0").value) };
    velocityPoints.push(p); updateVelocityList(); toast("速度点已保存");
  };
  $("#model-export").onclick = () => download(new Blob([JSON.stringify(model, null, 2)], {type:"application/json"}), "lpr-model.json");
  $("#model-velocity").onclick = () => toast("2-D 速度场已生成入口：后续偏移将读取该模型。");
  $("#three-axis").onchange = renderThree; $("#three-index").oninput = renderThree;
  bindModel();
  bindManualWorkbench();
}

function bindManualWorkbench() {
  const canvas = $("#manual-geo-radar-canvas");
  if (!canvas) return;
  canvas.addEventListener("contextmenu", e => e.preventDefault());
  canvas.addEventListener("wheel", e => {
    const ds = currentDisplayed();
    if (!ds) return;
    e.preventDefault();
    const point = manualPointFromEvent(e, false);
    if (!point) return;
    const factor = e.deltaY < 0 ? 0.78 : 1.28;
    zoomManualViewAt(point, factor, e.shiftKey ? "x" : (e.ctrlKey ? "y" : "both"));
  }, { passive: false });
  canvas.addEventListener("mousedown", e => {
    const ds = currentDisplayed();
    if (!ds) return;
    const rawPoint = manualPointFromEvent(e, false);
    const panRequested = e.button === 1 || e.button === 2 || e.altKey || (manualGeoTool === "drag" && rawPoint && !nearestManualPoint(rawPoint, 18));
    if (panRequested && rawPoint) {
      const view = { ...ensureManualView(ds) };
      manualGeoDrag = { type: "pan", x: e.clientX, y: e.clientY, view };
      return;
    }
    const point = manualPointFromEvent(e);
    if (!point) return;
    const st = ensureManualState();
    st.cursorTrace = point.traceIndex;
    if (manualGeoTool === "seed") {
      manualAutoTraceFromSeed(point);
      return;
    }
    if (manualGeoTool === "erase") {
      const hit = nearestManualPoint(point, 18);
      if (hit) {
        pushManualHistory();
        hit.layer.points.splice(hit.index, 1);
        if (!hit.layer.points.length) st.layers = st.layers.filter(l => l.id !== hit.layer.id);
        drawManualWorkbench();
      }
      return;
    }
    if (manualGeoTool === "drag") {
      const hit = nearestManualPoint(point, 18);
      if (hit) {
        pushManualHistory();
        manualGeoDrag = { type: "drag", layer: hit.layer, index: hit.index };
      }
      return;
    }
    const layer = activeManualLayer();
    if (layer.source === "auto") st.activeLayerId = createManualLayer("manual").id;
    const target = activeManualLayer();
    pushManualHistory();
    addManualPoint(target, point, manualGeoTool === "draw" ? 1 : 0);
    manualGeoDrag = manualGeoTool === "draw" ? { type: "draw", layer: target } : null;
    drawManualWorkbench();
  });
  canvas.addEventListener("mousemove", e => {
    if (manualGeoDrag?.type === "pan") {
      panManualView(manualGeoDrag.view, e.clientX - manualGeoDrag.x, e.clientY - manualGeoDrag.y);
      return;
    }
    const rawPoint = manualPointFromEvent(e, false);
    if (!rawPoint) return;
    const st = ensureManualState();
    st.cursorTrace = rawPoint.traceIndex;
    drawManualTraceAndSpectrum(rawPoint.traceIndex);
    if (!manualGeoDrag) return;
    const point = manualPointFromEvent(e);
    if (!point) return;
    if (manualGeoDrag.type === "draw") addManualPoint(manualGeoDrag.layer, point, 1);
    if (manualGeoDrag.type === "drag") {
      manualGeoDrag.layer.points[manualGeoDrag.index] = point;
      sortLayerPoints(manualGeoDrag.layer);
    }
    drawManualWorkbench();
  });
  addEventListener("mouseup", () => { manualGeoDrag = null; });
}

function bindLongPress(selector, fn) {
  $$(selector).forEach(btn => {
    let timer, interval;
    const start = () => { fn(btn); timer = setTimeout(() => interval = setInterval(() => fn(btn), 90), 350); };
    const stop = () => { clearTimeout(timer); clearInterval(interval); };
    btn.onmousedown = start; btn.onmouseup = stop; btn.onmouseleave = stop; btn.onclick = e => e.preventDefault();
  });
}
function makeDraggable(win) {
  if (!win) return;
  const head = win.querySelector(".float-head");
  if (!head) return;
  let drag = null;
  head.onmousedown = e => { if (e.target.tagName === "BUTTON") return; const r = win.getBoundingClientRect(); drag = { x:e.clientX-r.left, y:e.clientY-r.top }; };
  addEventListener("mousemove", e => { if (!drag) return; win.style.left = `${e.clientX-drag.x}px`; win.style.top = `${e.clientY-drag.y}px`; });
  addEventListener("mouseup", () => drag = null);
}
function openUndo() {
  $("#undo-list").innerHTML = store.snapshots.map((s,i)=>`<button value="cancel" data-restore="${i}">${i===0?"原始导入":`步骤 ${i}`} · ${s.numTraces}×${s.numSamples}</button>`).join("");
  $$("[data-restore]").forEach(b => b.onclick = () => { store.restore(Number(b.dataset.restore)); toast("已恢复历史状态"); });
}
async function computeSpecial(op, name) {
  if (!store.current) return toast("请先导入数据", "warn");
  const result = await runWorker(op, store.current, {});
  store.setOutput({ ...result, name }, { name, op, params:{} });
  displaySource = "output"; $("#display-mode").value = "output"; toast(`${name} 已生成 Output Data`);
}
async function computeAttenuation() {
  const ds = currentDisplayed(); if (!ds) return toast("请先导入数据", "warn");
  try {
    $("#footer-status").textContent = "正在计算 MATGPR 衰减特征";
    const result = await runWorker("attenuation-analysis", ds, {});
    store.setOutput({ ...result, name: `${ds.name || "data"}_attenuation` }, { name: "Attenuation Analysis", op: "attenuation-analysis", params: {} });
    displaySource = "output"; $("#display-mode").value = "output";
    openFloat("trace-window");
    drawLine($("#trace-canvas"), [...result.data.slice(0, result.numSamples)], { title:"Median instantaneous power", color:"#ffb020" });
    $("#trace-stats").textContent = `power-law t^${result.powerLaw?.[1]?.toFixed?.(3) ?? "?"} · exp ${result.exponential?.[1]?.toFixed?.(3) ?? "?"}`;
    $("#footer-status").textContent = "衰减特征已生成 Output Data";
    toast("Attenuation Analysis 已生成 Output Data");
  } catch (error) {
    toast(error.message, "err");
    $("#footer-status").textContent = "衰减特征计算失败";
  }
}
function simpleVelocityCalc() {
  const epsr = Number(prompt("epsilon_r", "9") || 9);
  const v = 0.299792458 / Math.sqrt(epsr);
  toast(`V = ${v.toFixed(4)} m/ns`);
}
function forwardModel() {
  const nt = 300, ns = 512, data = new Float32Array(nt*ns);
  for (const o of model.objects) {
    const x0 = Math.round((o.x / Math.max(1, $("#model-canvas").clientWidth)) * nt), z0 = Math.round((o.y / Math.max(1, $("#model-canvas").clientHeight)) * ns), amp = (o.epsr || 10) / 10;
    for (let t=0;t<nt;t++){ const s=Math.round(Math.sqrt(z0*z0+(t-x0)*(t-x0)*.8)); if(s>=0&&s<ns)data[t*ns+s]+=amp; }
  }
  store.setOutput({ data, numTraces:nt, numSamples:ns, name:"forward_model" }, { name:"正演模拟", op:"forward", params:{objects:model.objects.length} });
  displaySource = "output"; $("#display-mode").value = "output"; toast("正演模拟已生成 Output Data");
}

bindUi();
refresh();
