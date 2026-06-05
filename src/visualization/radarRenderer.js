const maps = {
  jet(t) {
    t = Math.max(0, Math.min(1, t));
    if (t < .125) return [0, 0, 128 + t / .125 * 127];
    if (t < .375) return [0, (t - .125) / .25 * 255, 255];
    if (t < .625) return [(t - .375) / .25 * 255, 255, 255 - (t - .375) / .25 * 255];
    if (t < .875) return [255, 255 - (t - .625) / .25 * 255, 0];
    return [255 - (t - .875) / .125 * 127, 0, 0];
  },
  gray(t) { const v = Math.max(0, Math.min(255, t * 255)); return [v, v, v]; },
  hot(t) { t = Math.max(0, Math.min(1, t)); return [Math.min(255, t * 3 * 255), Math.min(255, Math.max(0, t * 3 - 1) * 255), Math.min(255, Math.max(0, t * 3 - 2) * 255)]; },
  seismic(t) { t = Math.max(0, Math.min(1, t)); return t < .5 ? [0, 0, t * 2 * 255] : [(t - .5) * 2 * 255, 0, (1 - (t - .5) * 2) * 255]; }
};

/* default fallback (dark); setTheme() replaces at runtime */
function defaultTheme() {
  return {
    bg0:   "#000000",
    bg1:   "#080808",
    t0:    "#E8E5DF",
    t1:    "rgba(232,229,223,0.73)",
    t2:    "rgba(232,229,223,0.42)",
    t3:    "rgba(232,229,223,0.22)",
    gold:  "#C9A96E",
    goldBg:"rgba(201,169,110,0.08)",
    ok:    "#5B9A6B",
    er:    "#C25450",
    wn:    "#C9A96E",
    bg0Opaque: "#000000",  /* used for solid overlays like measure labels */
  };
}

function scaleValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0.2, Math.min(1, n)) : 1;
}

export class RadarRenderer {
  constructor(canvas, wrap, onCursor, callbacks = {}) {
    this.canvas = canvas;
    this.wrap = wrap;
    this.ctx = canvas.getContext("2d");
    this.onCursor = onCursor;
    this.callbacks = callbacks;
    this.theme = defaultTheme();
    this.ampMin = -10;
    this.ampMax = 10;
    this.cmap = "jet";
    this.currentTrace = 0;
    this.view = null;
    this.dataset = null;
    this.drag = null;
    this.markerLine = true;
    this.mode = "pan";
    this.verticalAxisMode = "sample";
    this.depthAxis = null;
    this.displayScale = { x: 1, y: 1 };
    this.selections = [];
    this.annotations = [];
    this.measurePoints = [];
    this.pendingAnnotation = null;
    this.liveSelection = null;
    new ResizeObserver(() => this.resize()).observe(wrap);
    this.bind();
    this.resize();
  }
  setTheme(t) { this.theme = t; this.render(); }
  setDataset(ds) {
    this.dataset = ds;
    this.view = ds ? this.defaultView(ds) : null;
    this.displayScale = { x: 1, y: 1 };
    this.currentTrace = 0;
    this.liveSelection = null;
    this.render();
  }
  setCurrentTrace(t) {
    if (!this.dataset) return;
    this.currentTrace = Math.max(0, Math.min(this.dataset.numTraces - 1, Math.round(t)));
    this.render();
  }
  setAmp(min, max) { this.ampMin = min; this.ampMax = max; this.render(); }
  setColormap(name) { this.cmap = name; this.render(); }
  setDisplayScale(x = 1, y = 1) {
    this.displayScale = { x: scaleValue(x), y: scaleValue(y) };
    this.render();
  }
  setVerticalAxisMode(mode = "sample", depthAxis = null) {
    this.verticalAxisMode = mode === "depth" ? "depth" : "sample";
    this.depthAxis = depthAxis;
    this.render();
  }
  verticalReadout(sample) {
    if (this.verticalAxisMode !== "depth") return { label: "样点", value: sample, text: `样点 ${sample}` };
    const axis = this.depthAxis || this.dataset?.depthAxisM || this.dataset?.meta?.depthAxisM;
    const step = this.dataset?.depthStep || this.dataset?.meta?.depthStep;
    let value = Number(axis?.[sample]);
    if (!Number.isFinite(value) && Number.isFinite(step)) value = sample * step;
    if (!Number.isFinite(value)) return { label: "样点", value: sample, text: `样点 ${sample}` };
    return { label: "深度", value, text: `深度 ${value.toFixed(3)} m` };
  }
  setMode(mode = "pan") {
    this.mode = this.mode === mode ? "pan" : mode;
    this.pendingAnnotation = null;
    if (this.mode !== "measure") this.measurePoints = [];
    this.liveSelection = null;
    this.render();
  }
  setSelections(selections = []) { this.selections = selections; this.render(); }
  setAnnotations(annotations = []) { this.annotations = annotations; this.render(); }
  zoomIn() { this.zoom(.5); }
  zoomOut() { this.zoom(2); }
  zoom(factor = 1) {
    if (!this.dataset || !this.view) return;
    const ct = (this.view.t0 + this.view.t1) / 2, cs = (this.view.s0 + this.view.s1) / 2;
    const nw = Math.max(12, (this.view.t1 - this.view.t0) * factor);
    const nh = Math.max(12, (this.view.s1 - this.view.s0) * factor);
    this.view.t0 = ct - nw / 2; this.view.t1 = ct + nw / 2;
    this.view.s0 = cs - nh / 2; this.view.s1 = cs + nh / 2;
    this.clamp(); this.render();
  }
  zoomFit() {
    if (!this.dataset) return;
    this.view = this.defaultView(this.dataset);
    this.displayScale = { x: 1, y: 1 };
    this.render();
  }
  zoomToSelection(sel) {
    if (!this.dataset || !sel) return;
    const start = Math.max(0, Math.min(sel.startT, sel.endT));
    const end = Math.min(this.dataset.numTraces - 1, Math.max(sel.startT, sel.endT));
    const pad = Math.max(3, Math.round((end - start + 1) * .08));
    this.view.t0 = start - pad; this.view.t1 = end + pad;
    this.clamp(); this.render();
  }
  resize() {
    const r = this.wrap.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.floor(r.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(r.height * dpr));
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = r.width; this.h = r.height;
    this.render();
  }
  defaultView(ds = this.dataset) {
    if (!ds) return null;
    const nt = Math.max(1, ds.numTraces || 1), ns = Math.max(1, ds.numSamples || 1);
    const metaView = ds.meta?.displayView || ds.displayView;
    const fallback = { t0: 0, t1: nt - 1, s0: 0, s1: ns - 1 };
    if (!metaView) return fallback;
    const view = {
      t0: Number(metaView.t0 ?? fallback.t0),
      t1: Number(metaView.t1 ?? fallback.t1),
      s0: Number(metaView.s0 ?? fallback.s0),
      s1: Number(metaView.s1 ?? fallback.s1)
    };
    if (![view.t0, view.t1, view.s0, view.s1].every(Number.isFinite)) return fallback;
    view.t0 = Math.max(0, Math.min(nt - 1, view.t0));
    view.t1 = Math.max(0, Math.min(nt - 1, view.t1));
    view.s0 = Math.max(0, Math.min(ns - 1, view.s0));
    view.s1 = Math.max(0, Math.min(ns - 1, view.s1));
    if (view.t1 <= view.t0) { view.t0 = fallback.t0; view.t1 = fallback.t1; }
    if (view.s1 <= view.s0) { view.s0 = fallback.s0; view.s1 = fallback.s1; }
    return view;
  }
  basePlot() { return { x: 56, y: 34, w: Math.max(1, this.w - 100), h: Math.max(1, this.h - 76) }; }
  plot() {
    const base = this.basePlot();
    const sx = scaleValue(this.displayScale?.x), sy = scaleValue(this.displayScale?.y);
    const w = Math.max(1, base.w * sx), h = Math.max(1, base.h * sy);
    return { x: base.x + (base.w - w) / 2, y: base.y + (base.h - h) / 2, w, h };
  }
  dataAt(px, py) {
    if (!this.dataset || !this.view) return null;
    const p = this.plot();
    if (px < p.x || px > p.x + p.w || py < p.y || py > p.y + p.h) return null;
    return {
      t: Math.round(this.view.t0 + (px - p.x) / p.w * (this.view.t1 - this.view.t0)),
      s: Math.round(this.view.s0 + (py - p.y) / p.h * (this.view.s1 - this.view.s0))
    };
  }
  bind() {
    this.canvas.addEventListener("wheel", e => {
      if (!this.dataset) return;
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect(), d = this.dataAt(e.clientX - r.left, e.clientY - r.top);
      if (!d) return;
      const f = e.deltaY > 0 ? 1.18 : .84;
      const vw = this.view.t1 - this.view.t0, vh = this.view.s1 - this.view.s0;
      const nw = Math.max(12, vw * f), nh = Math.max(12, vh * f);
      const rt = (d.t - this.view.t0) / vw, rs = (d.s - this.view.s0) / vh;
      this.view.t0 = d.t - rt * nw; this.view.t1 = this.view.t0 + nw;
      this.view.s0 = d.s - rs * nh; this.view.s1 = this.view.s0 + nh;
      this.clamp();
      this.render();
    }, { passive: false });
    this.canvas.addEventListener("mousedown", e => {
      const r = this.canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      const d = this.dataAt(px, py);
      if (!this.dataset || !this.view || !d) return;
      if (this.mode === "measure") {
        this.measurePoints.push(d);
        if (this.measurePoints.length > 2) this.measurePoints.shift();
        if (this.measurePoints.length === 2) this.callbacks.onMeasure?.(this.measurePoints[0], this.measurePoints[1]);
        this.render();
        return;
      }
      if (this.mode === "select") {
        this.drag = { type: "select", x: px, y: py, start: d.t };
        this.liveSelection = { startT: d.t, endT: d.t };
        this.render();
        return;
      }
      if (this.mode === "ann-point") {
        this.callbacks.onAnnotation?.({ type: "point", t: d.t, s: d.s, label: `P${this.annotations.length + 1}` });
        this.render();
        return;
      }
      if (this.mode === "ann-line" || this.mode === "ann-rect") {
        if (!this.pendingAnnotation) this.pendingAnnotation = d;
        else {
          this.callbacks.onAnnotation?.({
            type: this.mode === "ann-line" ? "line" : "rect",
            t1: this.pendingAnnotation.t,
            s1: this.pendingAnnotation.s,
            t2: d.t,
            s2: d.s
          });
          this.pendingAnnotation = null;
        }
        this.render();
        return;
      }
      this.drag = { type: "pan", x: px, y: py, view: { ...this.view } };
    });
    addEventListener("mousemove", e => {
      if (!this.dataset) return;
      const r = this.canvas.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      const d = this.dataAt(px, py);
      if (d) {
        this.currentTrace = Math.max(0, Math.min(this.dataset.numTraces - 1, d.t));
        const amp = this.dataset.data[d.t * this.dataset.numSamples + d.s];
        this.onCursor?.(d.t, d.s, amp);
      }
      if (!this.drag) { this.render(); return; }
      if (this.drag.type === "select") {
        if (d) this.liveSelection = { startT: Math.min(this.drag.start, d.t), endT: Math.max(this.drag.start, d.t) };
        this.render();
        return;
      }
      const p = this.plot(), dv = this.drag.view;
      const dt = (dv.t1 - dv.t0) / p.w, ds = (dv.s1 - dv.s0) / p.h;
      this.view.t0 = dv.t0 - (px - this.drag.x) * dt;
      this.view.t1 = dv.t1 - (px - this.drag.x) * dt;
      this.view.s0 = dv.s0 - (py - this.drag.y) * ds;
      this.view.s1 = dv.s1 - (py - this.drag.y) * ds;
      this.clamp();
      this.render();
    });
    addEventListener("mouseup", () => {
      if (this.drag?.type === "select" && this.liveSelection) {
        this.callbacks.onSelection?.(this.liveSelection);
        this.liveSelection = null;
        this.render();
      }
      this.drag = null;
    });
    this.canvas.addEventListener("mouseleave", () => this.onCursor?.());
  }
  clamp() {
    if (!this.dataset) return;
    const nt = this.dataset.numTraces, ns = this.dataset.numSamples;
    const w = this.view.t1 - this.view.t0, h = this.view.s1 - this.view.s0;
    if (this.view.t0 < 0) { this.view.t0 = 0; this.view.t1 = w; }
    if (this.view.s0 < 0) { this.view.s0 = 0; this.view.s1 = h; }
    if (this.view.t1 > nt - 1) { this.view.t1 = nt - 1; this.view.t0 = Math.max(0, this.view.t1 - w); }
    if (this.view.s1 > ns - 1) { this.view.s1 = ns - 1; this.view.s0 = Math.max(0, this.view.s1 - h); }
  }
  render() {
    const ctx = this.ctx, T = this.theme;
    ctx.fillStyle = T.bg0;
    ctx.fillRect(0, 0, this.w || 1, this.h || 1);
    if (!this.dataset || !this.view) {
      ctx.fillStyle = T.t2; ctx.textAlign = "center"; ctx.font = "14px Segoe UI";
      ctx.fillText("请先导入数据", (this.w || 1) / 2, (this.h || 1) / 2);
      return;
    }
    const p = this.plot();
    this.drawImage(p);
    this.drawAxes(p);
    this.drawSelections(p);
    this.drawMeasure(p);
    this.drawAnnotations(p);
    this.drawTraceLine(p);
    this.drawColorbar(p);
  }
  drawImage(p) {
    const { data, numTraces: nt, numSamples: ns } = this.dataset;
    const pw = Math.floor(p.w), ph = Math.floor(p.h);
    const img = this.ctx.createImageData(pw, ph);
    const fn = maps[this.cmap] || maps.jet, range = this.ampMax - this.ampMin || 1;
    for (let y = 0; y < ph; y++) {
      const s = Math.max(0, Math.min(ns - 1, Math.floor(this.view.s0 + y / ph * (this.view.s1 - this.view.s0))));
      for (let x = 0; x < pw; x++) {
        const t = Math.max(0, Math.min(nt - 1, Math.floor(this.view.t0 + x / pw * (this.view.t1 - this.view.t0))));
        const [r, g, b] = fn((data[t * ns + s] - this.ampMin) / range);
        const i = (y * pw + x) * 4;
        img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
      }
    }
    const off = document.createElement("canvas");
    off.width = pw; off.height = ph; off.getContext("2d").putImageData(img, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(off, p.x, p.y, p.w, p.h);
  }
  drawAxes(p) {
    const ctx = this.ctx, T = this.theme;
    ctx.save();
    ctx.strokeStyle = T.t1;  /* axis border */
    ctx.strokeRect(p.x, p.y, p.w, p.h);
    ctx.fillStyle = T.t0;    /* axis labels */
    ctx.shadowColor = T.bg0Opaque;
    ctx.shadowBlur = 5;
    ctx.font = "11px Consolas";
    ctx.textAlign = "center";
    for (let i = 0; i <= 6; i++) {
      const f = i / 6, x = p.x + f * p.w, t = Math.round(this.view.t0 + f * (this.view.t1 - this.view.t0));
      ctx.fillText(t, x, p.y + p.h + 16);
    }
    ctx.textAlign = "right";
    for (let i = 0; i <= 6; i++) {
      const f = i / 6, y = p.y + f * p.h, s = Math.round(this.view.s0 + f * (this.view.s1 - this.view.s0));
      const readout = this.verticalReadout(s);
      ctx.fillText(readout.label === "深度" ? readout.value.toFixed(2) : s, p.x - 7, y + 3);
    }
    ctx.textAlign = "center"; ctx.fillText("道号", p.x + p.w / 2, p.y + p.h + 31);
    ctx.save(); ctx.translate(15, p.y + p.h / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(this.verticalAxisMode === "depth" ? "深度 (m)" : "采样点 / 时间", 0, 0); ctx.restore();
    ctx.restore();
  }
  drawTraceLine(p) {
    if (!this.markerLine || !this.dataset) return;
    const x = p.x + (this.currentTrace - this.view.t0) / (this.view.t1 - this.view.t0) * p.w;
    if (x < p.x || x > p.x + p.w) return;
    this.ctx.strokeStyle = this.theme.t0;
    this.ctx.setLineDash([5, 4]);
    this.ctx.beginPath(); this.ctx.moveTo(x, p.y); this.ctx.lineTo(x, p.y + p.h); this.ctx.stroke();
    this.ctx.setLineDash([]);
  }
  drawSelections(p) {
    if (!this.dataset || !this.view) return;
    const T = this.theme, goldStrong = "rgba(201,169,110,0.18)", goldDim = "rgba(201,169,110,0.08)";
    const draw = (sel, strong = false) => {
      const x1 = p.x + (sel.startT - this.view.t0) / (this.view.t1 - this.view.t0) * p.w;
      const x2 = p.x + (sel.endT - this.view.t0) / (this.view.t1 - this.view.t0) * p.w;
      const x = Math.max(p.x, Math.min(x1, x2));
      const w = Math.min(p.x + p.w, Math.max(x1, x2)) - x;
      if (w <= 0) return;
      this.ctx.fillStyle = strong ? goldStrong : goldDim;
      this.ctx.strokeStyle = strong ? T.gold : "rgba(201,169,110,0.55)";
      this.ctx.lineWidth = strong ? 1.6 : 1;
      this.ctx.setLineDash(strong ? [] : [4, 3]);
      this.ctx.fillRect(x, p.y, w, p.h);
      this.ctx.strokeRect(x, p.y, w, p.h);
      this.ctx.setLineDash([]);
    };
    for (const sel of this.selections) draw(sel, false);
    if (this.liveSelection) draw(this.liveSelection, true);
  }
  drawMeasure(p) {
    if (!this.measurePoints.length || !this.view) return;
    const T = this.theme;
    const xy = pt => ({
      x: p.x + (pt.t - this.view.t0) / (this.view.t1 - this.view.t0) * p.w,
      y: p.y + (pt.s - this.view.s0) / (this.view.s1 - this.view.s0) * p.h
    });
    const pts = this.measurePoints.map(xy);
    this.ctx.fillStyle = T.wn;
    this.ctx.strokeStyle = T.wn;
    this.ctx.lineWidth = 1.8;
    for (const q of pts) { this.ctx.beginPath(); this.ctx.arc(q.x, q.y, 4, 0, Math.PI * 2); this.ctx.fill(); }
    if (pts.length === 2) {
      this.ctx.setLineDash([6, 3]);
      this.ctx.beginPath(); this.ctx.moveTo(pts[0].x, pts[0].y); this.ctx.lineTo(pts[1].x, pts[1].y); this.ctx.stroke();
      this.ctx.setLineDash([]);
      const a = this.measurePoints[0], b = this.measurePoints[1], label = `dT ${Math.abs(b.t - a.t)} / dS ${Math.abs(b.s - a.s)}`;
      const lx = (pts[0].x + pts[1].x) / 2, ly = (pts[0].y + pts[1].y) / 2;
      this.ctx.fillStyle = T.bg0Opaque;
      this.ctx.fillRect(lx - 54, ly - 22, 108, 18);
      this.ctx.fillStyle = T.wn;
      this.ctx.font = "10px Consolas";
      this.ctx.textAlign = "center";
      this.ctx.fillText(label, lx, ly - 9);
    }
  }
  drawAnnotations(p) {
    if (!this.view) return;
    const T = this.theme;
    const xy = (t, s) => ({
      x: p.x + (t - this.view.t0) / (this.view.t1 - this.view.t0) * p.w,
      y: p.y + (s - this.view.s0) / (this.view.s1 - this.view.s0) * p.h
    });
    const drawAnn = (a, ghost = false) => {
      this.ctx.globalAlpha = ghost ? .75 : 1;
      if (a.type === "point") {
        const q = xy(a.t, a.s);
        this.ctx.fillStyle = T.er; this.ctx.beginPath(); this.ctx.arc(q.x, q.y, 4, 0, Math.PI * 2); this.ctx.fill();
        this.ctx.fillStyle = T.t0; this.ctx.font = "10px Segoe UI"; this.ctx.textAlign = "left"; this.ctx.fillText(a.label || "P", q.x + 7, q.y + 3);
      } else if (a.type === "line") {
        const a0 = xy(a.t1, a.s1), a1 = xy(a.t2, a.s2);
        this.ctx.strokeStyle = T.ok; this.ctx.lineWidth = 1.8; this.ctx.beginPath(); this.ctx.moveTo(a0.x, a0.y); this.ctx.lineTo(a1.x, a1.y); this.ctx.stroke();
      } else if (a.type === "rect") {
        const a0 = xy(a.t1, a.s1), a1 = xy(a.t2, a.s2);
        this.ctx.strokeStyle = T.wn; this.ctx.lineWidth = 1.4; this.ctx.setLineDash([5, 3]);
        this.ctx.strokeRect(Math.min(a0.x, a1.x), Math.min(a0.y, a1.y), Math.abs(a1.x - a0.x), Math.abs(a1.y - a0.y));
        this.ctx.setLineDash([]);
      }
      this.ctx.globalAlpha = 1;
    };
    for (const a of this.annotations) drawAnn(a);
    if (this.pendingAnnotation) drawAnn({ type: "point", t: this.pendingAnnotation.t, s: this.pendingAnnotation.s, label: "1" }, true);
  }
  drawColorbar(p) {
    const ctx = this.ctx, T = this.theme, fn = maps[this.cmap] || maps.jet, x = p.x + p.w + 8, y = p.y, h = p.h;
    for (let i = 0; i < h; i++) {
      const [r, g, b] = fn(1 - i / h);
      ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fillRect(x, y + i, 12, 1);
    }
    ctx.strokeStyle = T.t1; ctx.strokeRect(x, y, 12, h);
    ctx.fillStyle = T.t0; ctx.shadowColor = T.bg0Opaque; ctx.shadowBlur = 4; ctx.font = "9px Consolas"; ctx.textAlign = "left";
    ctx.fillText(this.ampMax.toFixed(1), x + 16, y + 8);
    ctx.fillText(this.ampMin.toFixed(1), x + 16, y + h);
  }
}

export function drawLine(canvas, values, opts = {}, theme) {
  const T = theme || defaultTheme();
  const rect = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  canvas.width = Math.max(1, rect.width * dpr); canvas.height = Math.max(1, rect.height * dpr);
  const ctx = canvas.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = rect.width, h = rect.height, m = { l: 48, r: 14, t: 22, b: 28 };
  ctx.fillStyle = T.bg0; ctx.fillRect(0, 0, w, h);
  if (!values?.length) return;
  let min = Math.min(...values), max = Math.max(...values); if (min === max) { min--; max++; }
  ctx.strokeStyle = T.t3; ctx.lineWidth = .5;
  for (let i = 0; i <= 5; i++) { const y = m.t + i / 5 * (h - m.t - m.b); ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(w - m.r, y); ctx.stroke(); }
  ctx.strokeStyle = opts.color || T.gold; ctx.lineWidth = 1.4; ctx.beginPath();
  for (let i = 0; i < values.length; i++) {
    const x = m.l + i / Math.max(1, values.length - 1) * (w - m.l - m.r);
    const y = m.t + (1 - (values[i] - min) / (max - min)) * (h - m.t - m.b);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = T.t2; ctx.font = "10px Consolas"; ctx.textAlign = "right";
  ctx.fillText(max.toExponential(2), m.l - 6, m.t + 8);
  ctx.fillText(min.toExponential(2), m.l - 6, h - m.b);
  if (opts.title) { ctx.textAlign = "left"; ctx.fillText(opts.title, m.l, 14); }
}
