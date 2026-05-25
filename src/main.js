import { RECORD_SIZE, SAMPLES_PER_TRACE, parse2BFile, write2BFile, writeMgpJson, writeSEGYLike, writeSEGYFile, writeDZTFile } from "./io/twoB.js";
import { parseHadText, parseHcdFile } from "./io/hcd.js";
import { IpdStore } from "./processing/ipdStore.js";
import { depthAxisFromVofh, spectrum, fkSpectrum } from "./processing/algorithms.js";
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
let dataManagerSelection = new Set();
let velocityRenderer = null;
let velocityPreviewPoint = null;
let velocityFixedPoint = null;
let depthAxisEnabled = false;
let currentVofhText = "0.1,0";

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
    worker.postMessage({ id, op, params, dataset: { ...dataset, data: copy.buffer } }, [copy.buffer]);
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
  $("#dataset-title").textContent = store.ipd ? `${store.ipd.name} · ${displaySource === "output" && store.output ? "Output Data" : "Current Input Data"}` : "未加载数据";
  $("#drop-zone").classList.toggle("hidden", !!store.current);
  radar.setDataset(ds);
  applyDepthAxisMode();
  $("#state-panel").innerHTML = store.ipd ? [
    row("Current", `${store.current.numTraces} 道 × ${store.current.numSamples} 样点`),
    row("Output", store.output ? `${store.output.numTraces} 道 × ${store.output.numSamples} 样点，待验收` : "无"),
    row("dt / dx", `${(store.current.meta?.dtNs || store.current.dtNs || 0.625).toFixed?.(4) || store.current.meta?.dtNs || 0.625} ns · ${(store.current.meta?.dxM || store.current.dxM || 0.05).toFixed?.(4) || store.current.meta?.dxM || 0.05} m`),
    row("历史", `${store.ipd.history.length} 步`),
    row("格式", store.current.meta?.sourceFormat || ".2B")
  ].join("") : "暂无数据";
  $("#history-panel").innerHTML = store.ipd?.history.length ? store.ipd.history.map((h, i) => `<div class="history-item"><b>${i + 1}. ${h.name}</b><br><span>${h.createdAt || ""}</span><br><code>${JSON.stringify(h.params || {})}</code></div>`).join("") : "暂无历史";
  updateVelocityList();
  renderDataManager();
  renderThree();
}
function row(k, v) { return `<div><span class="muted">${k}</span><br><b>${v}</b></div>`; }
store.addEventListener("change", refresh);

function formatVofh(vofh) {
  return Array.isArray(vofh) ? vofh.map(row => `${row[0]},${row[1] ?? 0}`).join("\n") : (typeof vofh === "string" ? vofh : "");
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
  const dtNs = ds.meta?.dtNs || ds.dtNs || 0.625;
  return depthAxisFromVofh(ds.numSamples, dtNs, currentVofhText || ds.meta?.vofh || "0.1,0");
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
  store.loadDataset({ ...parsed, name: file.name, fileSize: file.size, loadedAt: new Date().toLocaleString("zh-CN") });
  clearInteractionState();
  toast(`${file.name} 导入成功`);
  $("#footer-status").textContent = "导入完成";
  switchPage("radar");
}

async function read2BImport(file) {
  $("#footer-status").textContent = `正在解析 ${file.name}`;
  finishImport(parse2BFile(await file.arrayBuffer()), file);
}

function ensureHcdManualDialog() {
  let dlg = $("#hcd-manual-dialog");
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.id = "hcd-manual-dialog";
  dlg.innerHTML = `
    <form method="dialog">
      <h2>HCD 手动参数</h2>
      <p class="muted">未同时选择同名 .had 文件，请填写 .hcd 样点矩阵参数。</p>
      <div class="dialog-fields">
        <label>DATA BIT<input id="hcd-bit" value="16"></label>
        <label>SAMPLES<input id="hcd-samples" value=""></label>
        <label>TRACE NUMBER<input id="hcd-traces" value=""></label>
        <label>TIMEWINDOW ns<input id="hcd-timewindow" value=""></label>
        <label>FREQUENCY MHz<input id="hcd-frequency" value=""></label>
        <label>TRACE INCREMENT m<input id="hcd-dx" value="0.01"></label>
        <label>Endian
          <select id="hcd-endian">
            <option value="little">little-endian</option>
            <option value="big">big-endian</option>
          </select>
        </label>
      </div>
      <menu>
        <button value="cancel">取消</button>
        <button id="hcd-manual-run" value="default" class="primary">导入 HCD</button>
      </menu>
    </form>`;
  document.body.appendChild(dlg);
  return dlg;
}

function requestHcdManualParams(file) {
  const dlg = ensureHcdManualDialog();
  const updateTraceHint = () => {
    const bytes = Number($("#hcd-bit")?.value || 16) / 8 || 2;
    const samples = Number($("#hcd-samples")?.value || 0);
    $("#hcd-traces").placeholder = file?.size && samples > 0 ? String(Math.floor(file.size / (samples * bytes))) : "";
  };
  $("#hcd-bit").oninput = updateTraceHint;
  $("#hcd-samples").oninput = updateTraceHint;
  updateTraceHint();
  return new Promise(resolve => {
    dlg.onclose = () => {
      if (dlg.returnValue !== "default") return resolve(null);
      resolve({
        dataBit: Number($("#hcd-bit").value),
        samples: Number($("#hcd-samples").value),
        traces: Number($("#hcd-traces").value),
        timeWindowNs: Number($("#hcd-timewindow").value),
        frequencyMHz: Number($("#hcd-frequency").value),
        dxM: Number($("#hcd-dx").value || 1),
        littleEndian: $("#hcd-endian").value !== "big"
      });
    };
    dlg.showModal();
  });
}

async function readHcdImport(hcdFile, hadFile = null) {
  $("#footer-status").textContent = `正在解析 ${hcdFile.name}`;
  const params = hadFile ? parseHadText(await hadFile.text()) : await requestHcdManualParams(hcdFile);
  if (!params) {
    $("#footer-status").textContent = "HCD 导入已取消";
    return;
  }
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
  "dzt-gain": ["Remove DZT header gain", [{ id: "gain", label: "Gain points (dB, comma-separated)", value: "0,2,4,6,8,10" }]],
  "equalize": ["均衡轨迹", []],
  "resample-time": ["重采样时间轴", [{ id: "samples", label: "新样点数", value: 2048 }, { id: "dtNs", label: "当前 dt (ns)", value: 0.625 }, { id: "order", label: "sinc 半阶", value: 15 }]],
  "resample-scan": ["重采样扫描轴", [{ id: "traces", label: "新道数", value: 512 }, { id: "dxM", label: "当前 dx (m)", value: 0.05 }, { id: "order", label: "sinc 半阶", value: 15 }]],
  "equal-spacing": ["转换为等间距", [{ id: "traces", label: "等间距道数", value: 512 }, { id: "dxM", label: "当前 dx (m)", value: 0.05 }, { id: "order", label: "sinc 半阶", value: 15 }]],
  agc: ["Standard AGC", [{ id: "windowNs", label: "AGC 窗口 (ns)", value: 31.25 }, { id: "dtNs", label: "dt (ns)", value: 0.625 }]],
  gagc: ["Gaussian-tapered AGC", [{ id: "windowNs", label: "AGC 窗口 (ns)", value: 31.25 }, { id: "dtNs", label: "dt (ns)", value: 0.625 }, { id: "eps", label: "EPS", value: 5e-7 }]],
  "power-gain": ["Inverse Power Decay", [{ id: "power", label: "幂次 auto 或数字", value: "auto" }, { id: "dtNs", label: "dt (ns)", value: 0.625 }]],
  "amplitude-gain": ["Inverse Amplitude Decay", [{ id: "curve", label: "衰减曲线 median/mean", value: "median" }, { id: "order", label: "多指数阶数", value: 3 }, { id: "dtNs", label: "dt (ns)", value: 0.625 }]],
  "global-bg": ["Remove Global Background", []],
  horizontal: ["Suppress Horizontal Features", [{ id: "width", label: "滑动窗口道数", value: 25 }]],
  dipping: ["Suppress Dipping Features", [{ id: "width", label: "滑动窗口道数", value: 25 }]],
  "fir-frequency": ["FIR Frequency Filter", [{ id: "type", label: "类型 bp/lp/hp/bs", value: "bp" }, { id: "lo", label: "低频 MHz", value: 20 }, { id: "hi", label: "高频 MHz", value: 200 }, { id: "dtNs", label: "dt (ns)", value: 0.625 }]],
  "fir-wavenumber": ["FIR Wavenumber Filter", [{ id: "type", label: "类型 bp/lp/hp/bs", value: "bp" }, { id: "loK", label: "低波数 m^-1", value: 0.2 }, { id: "hiK", label: "高波数 m^-1", value: 5 }, { id: "dxM", label: "dx (m)", value: 0.05 }]],
  "fk-filter": ["F-K Filter", []],
  "kl-filter": ["Karhunen-Loeve Filter", [{ id: "components", label: "主成分个数 P", value: 9 }, { id: "output", label: "输出 model/residual", value: "model" }]],
  "fx-decon": ["F-X Deconvolution", [{ id: "operatorLength", label: "预测算子长度", value: 8 }, { id: "muPercent", label: "预白化 (%)", value: 1 }, { id: "flowMHz", label: "低频 MHz", value: 20 }, { id: "fhighMHz", label: "高频 MHz", value: 600 }]],
  "sparse-decon": ["Sparse Deconvolution", [{ id: "frequencyMHz", label: "Ricker 主频 MHz", value: 100 }, { id: "lengthSamples", label: "子波长度样点", value: 64 }, { id: "mu", label: "L1 正则 mu", value: 0.01 }, { id: "iterations", label: "IRLS 迭代", value: 10 }, { id: "output", label: "输出 reflectivity/predicted", value: "reflectivity" }]],
  "attenuation-analysis": ["Attenuation Analysis", []],
  "mean-median-filter": ["Mean/Median Filter", [{ id: "mode", label: "Mode mean/median", value: "mean" }, { id: "vSize", label: "垂直窗口(样点)", value: 3 }, { id: "hSize", label: "水平窗口(道)", value: 3 }]],
  "notch-filter": ["Notch Filter", [{ id: "frequencyMHz", label: "陷波频率 MHz", value: 50 }, { id: "dtNs", label: "dt (ns)", value: 0.625 }]],
  predc: ["Predictive Deconvolution", [{ id: "operatorLength", label: "预测算子长度(样点)", value: 32 }, { id: "predictionLength", label: "预测距离(样点)", value: 1 }, { id: "muPercent", label: "预白化 (%)", value: 5 }]],
  "static-correction": ["Static Corrections", [{ id: "elevation", label: "高程值(逗号分隔)", value: "0" }, { id: "swv", label: "表层速度 m/ns", value: .1 }, { id: "wv", label: "次表层速度 m/ns", value: .1 }]],
  "advanced-placeholder": ["Tau-P / Curvelet / FDTD", []],
  instantaneous: ["瞬时属性", [{ id: "attr", label: "属性 amplitude/atan/atan2/unwrapped/ifreq", value: "amplitude" }, { id: "dtNs", label: "dt (ns)", value: 0.625 }]],
  stolt: ["1-D F-K / Stolt Migration", [{ id: "vofh", label: "层状速度模型: 速度,厚度", value: "0.1,0", type: "textarea" }, { id: "dtNs", label: "dt ns", value: .625 }, { id: "dxM", label: "dx m", value: .05 }]],
  gazdag: ["1-D Phase-shift / Gazdag", [{ id: "vofh", label: "层状速度模型: 速度,厚度", value: "0.1,0", type: "textarea" }, { id: "dtNs", label: "dt ns", value: .625 }, { id: "dxM", label: "dx m", value: .05 }]],
  "time-depth": ["Time-to-Depth Conversion", [{ id: "vofh", label: "层状速度模型: 速度,厚度", value: "0.1,0", type: "textarea" }, { id: "dtNs", label: "dt ns", value: .625 }, { id: "dzM", label: "深度采样 m", value: .02 }]],
  pspi: ["2-D PSPI Migration", [{ id: "velocity", label: "参考速度 m/ns", value: .1 }, { id: "dt", label: "dt ns", value: .625 }, { id: "dx", label: "dx m", value: .05 }, { id: "dzM", label: "深度步长 m", value: .02 }, { id: "zMaxM", label: "最大深度 m (可空)", value: "" }]],
  "split-step": ["2-D Split-step Fourier", [{ id: "vofh", label: "层状速度模型: 速度,厚度", value: "0.1,0", type: "textarea" }, { id: "dtNs", label: "dt ns", value: .625 }, { id: "dxM", label: "dx m", value: .05 }, { id: "dzM", label: "深度步长 m", value: .02 }, { id: "zMaxM", label: "最大深度 m (可空)", value: "" }, { id: "fMaxGHz", label: "最高频率 GHz (可空)", value: "" }, { id: "q", label: "Q (可空)", value: "" }, { id: "antennaFreqMHz", label: "天线频率 MHz (可空)", value: "" }]]
};

function openProcess(op) {
  if (!store.current) return toast("请先导入数据", "warn");
  if (op === "fk-filter") return openFkDesigner();
  const [title, fields] = processDefs[op] || [op, []];
  const fieldValue = f => {
    const ds = store.current;
    if (f.id === "vofh") return formatVofh(ds.meta?.vofh) || currentVofhText || f.value;
    if (f.id === "dtNs") return ds.meta?.dtNs || ds.dtNs || f.value;
    if (f.id === "dxM") return ds.meta?.dxM || ds.dxM || f.value;
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
        params[key] = isNaN(Number(i.value)) || ["type", "ranges", "curve", "attr", "power", "output", "vofh", "gain"].includes(key) ? i.value : Number(i.value);
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
  const dt = ds.meta?.dtNs || ds.dtNs || 0.625;
  const dx = ds.meta?.dxM || ds.dxM || 0.05;
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
  if (name === "velocity") renderVelocity();
  if (name === "model") renderModel();
  if (name === "three") renderThree();
  if (name === "interpret") drawGeologyResult();
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
  radar.setSelections([]);
  radar.setAnnotations([]);
  updateSelectionPanel();
  updateAnnotationPanel();
  if ($("#geo-report")) $("#geo-report").innerHTML = "尚未生成自动地质模型。";
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
  $("#data-merge-export").disabled = selectedItems.length < 2;
  $("#data-clear-selection").disabled = selectedItems.length === 0;
  body.innerHTML = items.map(item => {
    const can2B = item.numSamples === SAMPLES_PER_TRACE;
    const checked = dataManagerSelection.has(item.id) ? "checked" : "";
    const disabled = can2B ? "" : "disabled";
    const status = item.managedStatus ? `<span class="data-status">${escapeHtml(item.managedStatus)}</span>` : "";
    return `<tr class="${item.isCurrent ? "current" : ""}">
      <td><input type="checkbox" data-data-select="${item.id}" ${checked} ${disabled} title="${can2B ? "选择合并导出" : "样点数不是 2048，不能合并导出 .2B"}"></td>
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
function mergeSelectedManagedDatasets() {
  const selected = (store.managedDatasets || []).filter(item => dataManagerSelection.has(item.id));
  if (selected.length < 2) return toast("请至少选择两个 .2B 数据集", "warn");
  if (selected.some(item => item.numSamples !== SAMPLES_PER_TRACE)) return toast("只能合并每道 2048 样点的 .2B 数据集", "warn");
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
  const out = { sourceFormat: ".2B" };
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
  const out = {};
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
  if (t < .125) return [0, 0, Math.round(128 + t / .125 * 127)];
  if (t < .375) return [0, Math.round((t - .125) / .25 * 255), 255];
  if (t < .625) return [Math.round((t - .375) / .25 * 255), 255, Math.round(255 - (t - .375) / .25 * 255)];
  if (t < .875) return [255, Math.round(255 - (t - .625) / .25 * 255), 0];
  return [Math.round(255 - (t - .875) / .125 * 127), 0, 0];
}
function renderDatasetCanvas(canvas, ds, opts = {}) {
  if (!canvas || !ds) return;
  const rect = canvas.parentElement?.getBoundingClientRect?.() || { width: canvas.width || 900, height: canvas.height || 320 };
  const dpr = devicePixelRatio || 1, w = Math.max(1, Math.floor(rect.width)), h = Math.max(1, Math.floor(rect.height));
  canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d"); ctx.setTransform(dpr,0,0,dpr,0,0);
  const img = ctx.createImageData(w, h), min = opts.min ?? -10, max = opts.max ?? 10, range = max - min || 1;
  const displaySamples = Math.min(ds.numSamples, opts.sampleMax || ds.numSamples);
  for (let y = 0; y < h; y++) {
    const s = Math.min(ds.numSamples - 1, Math.floor(y / h * displaySamples));
    for (let x = 0; x < w; x++) {
      const t = Math.min(ds.numTraces - 1, Math.floor(x / w * ds.numTraces));
      const [r,g,b] = colorOf(opts.cmap || "seismic", (ds.data[t * ds.numSamples + s] - min) / range);
      const i = (y * w + x) * 4; img.data[i] = r; img.data[i+1] = g; img.data[i+2] = b; img.data[i+3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  if (opts.horizons?.length) {
    ctx.lineWidth = 1.3; ctx.setLineDash([5,3]);
    const colors = ["#ffe066","#69db7c","#74c0fc","#ff922b","#da77f2","#63e6be"];
    opts.horizons.forEach((hzn, i) => {
      ctx.strokeStyle = colors[i % colors.length]; ctx.beginPath();
      const line = hzn.line || [];
      for (let x = 0; x < w; x++) {
        const t = Math.min(line.length - 1, Math.floor(x / w * line.length));
        const y = (line[t] / (opts.modelDepthMax || 24)) * h;
        x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.stroke();
    });
    ctx.setLineDash([]);
  }
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
  const params = {
    velocity: Number($("#geo-velocity")?.value || 0.1),
    dt: Number($("#geo-dt")?.value || 0.3125),
    dx: Number($("#geo-dx")?.value || 0.05),
    loMHz: Number($("#geo-lo")?.value || 20),
    hiMHz: Number($("#geo-hi")?.value || 900),
    bgWidth: Number($("#geo-bg")?.value || 25),
    agcWindow: Number($("#geo-agc")?.value || 80),
    modelDepthMax: Number($("#geo-depth")?.value || 24)
  };
  $("#footer-status").textContent = "正在自动提取界面并生成地质模型";
  try {
    geologyResult = await runWorker("geology-model", ds, params);
    store.setOutput({ data: geologyResult.data, numTraces: geologyResult.numTraces, numSamples: geologyResult.numSamples, name: `${ds.name || "data"}_geology_processed`, meta: ds.meta }, { name: "自动地质建模", op: "geology-model", params });
    displaySource = "output"; $("#display-mode").value = "output";
    drawGeologyResult();
    $("#footer-status").textContent = "自动地质建模完成，Output Data 已生成";
    toast("自动地质模型已生成");
  } catch (error) {
    toast(error.message, "err");
    $("#footer-status").textContent = "自动地质建模失败";
  }
}
function drawGeologyResult() {
  if (!geologyResult) return;
  renderDatasetCanvas($("#geo-radar-canvas"), { data: geologyResult.data, numTraces: geologyResult.numTraces, numSamples: geologyResult.numSamples }, {
    cmap: "seismic", min: -2.2, max: 2.2, horizons: geologyResult.horizons, modelDepthMax: geologyResult.modelDepthMax, sampleMax: Math.ceil(geologyResult.modelDepthMax / geologyResult.depthStep)
  });
  drawLayerModelCanvas($("#geo-model-canvas"), geologyResult);
  const rows = geologyResult.horizons.map(h => `<tr><td>${h.name}</td><td>${h.medianDepth.toFixed(2)} m</td><td>${h.minDepth.toFixed(2)}-${h.maxDepth.toFixed(2)} m</td><td>${h.layerName}</td><td>${h.meaning}</td></tr>`).join("");
  $("#geo-report").innerHTML = `<div class="geo-kpis"><span>速度 ${geologyResult.velocity.toFixed(3)} m/ns</span><span>εr ${geologyResult.epsilonR.toFixed(2)}</span><span>${geologyResult.numTraces} 道 × ${geologyResult.numSamples} 样点</span></div><table class="mini-table"><thead><tr><th>界面</th><th>中值深度</th><th>范围</th><th>层位命名</th><th>含义</th></tr></thead><tbody>${rows}</tbody></table>`;
}
function drawLayerModelCanvas(canvas, result) {
  if (!canvas || !result) return;
  const rect = canvas.parentElement.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(rect.width)), h = Math.max(1, Math.floor(rect.height));
  canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d"); ctx.setTransform(dpr,0,0,dpr,0,0);
  const palette = [[234,215,183],[214,191,130],[183,193,138],[143,182,161],[120,149,178],[111,116,132],[68,72,87]];
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const zi = Math.min(result.modelSamples - 1, Math.floor(y / h * result.modelSamples));
    const ti = Math.min(result.modelTraces - 1, Math.floor(x / w * result.modelTraces));
    const c = palette[result.modelData[zi * result.modelTraces + ti] || 0], i = (y * w + x) * 4;
    img.data[i] = c[0]; img.data[i+1] = c[1]; img.data[i+2] = c[2]; img.data[i+3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = "#101828"; ctx.lineWidth = 1.2;
  for (const hzn of result.horizons) {
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const t = Math.min(hzn.line.length - 1, Math.floor(x / w * hzn.line.length));
      const y = hzn.line[t] / result.modelDepthMax * h;
      x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
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

function exportData(kind) {
  const ds = $("#export-source").value === "output" && store.output ? store.output : store.current;
  if (!ds) return toast("无可导出数据", "warn");
  try {
    if (kind === "2b") download(write2BFile(ds), dataFileName(ds.name));
    else if (kind === "mgp") download(writeMgpJson(store.ipd), `${store.ipd.name}.mgp.json`);
    else if (kind === "depth") download(writeMgpJson({ ...store.ipd, current: ds }), `${store.ipd.name}_depth.json`);
    else if (kind === "segy") download(writeSEGYFile(ds, Number($("#export-dt")?.value || 0.001), Number($("#export-dx")?.value || 0.05)), `${(ds.name || "data").replace(/\.\w+$/i, "")}.sgy`);
    else if (kind === "dzt") download(writeDZTFile(ds, Number($("#export-dzt-dt")?.value || 0.625), Number($("#export-dx")?.value || 0.05), Number($("#export-range")?.value || ds.numSamples * 0.625)), `${(ds.name || "data").replace(/\.\w+$/i, "")}.dzt`);
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
    if (e.target.dataset.dataSelect) {
      e.target.checked ? dataManagerSelection.add(e.target.dataset.dataSelect) : dataManagerSelection.delete(e.target.dataset.dataSelect);
      renderDataManager();
    }
    if (e.target.dataset.dataUse) useManagedDataset(e.target.dataset.dataUse);
    if (e.target.dataset.dataRename) renameManagedDataset(e.target.dataset.dataRename);
    if (e.target.dataset.dataExport) exportManagedDataset(e.target.dataset.dataExport);
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
    if (action === "data-clear-selection") { dataManagerSelection.clear(); renderDataManager(); }
    if (action === "annotation-export") download(new Blob([JSON.stringify(radarAnnotations, null, 2)], { type: "application/json" }), "annotations.json");
    if (action === "annotation-clear") { radarAnnotations = []; updateAnnotationPanel(); }
    if (action === "run-geology") runGeologyModel();
    if (action === "export-geology") exportGeologyJson();
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
  $("#display-mode").onchange = e => { displaySource = e.target.value; refresh(); };
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
  $("#undo-dialog").showModal();
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
  const epsr = Number(prompt("相对介电常数 εr", "9") || 9);
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
