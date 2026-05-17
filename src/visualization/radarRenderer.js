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

export class RadarRenderer {
  constructor(canvas, wrap, onCursor) {
    this.canvas = canvas;
    this.wrap = wrap;
    this.ctx = canvas.getContext("2d");
    this.onCursor = onCursor;
    this.ampMin = -10;
    this.ampMax = 10;
    this.cmap = "jet";
    this.currentTrace = 0;
    this.view = null;
    this.dataset = null;
    this.drag = null;
    this.markerLine = true;
    new ResizeObserver(() => this.resize()).observe(wrap);
    this.bind();
    this.resize();
  }
  setDataset(ds) {
    this.dataset = ds;
    this.view = ds ? { t0: 0, t1: ds.numTraces - 1, s0: 0, s1: ds.numSamples - 1 } : null;
    this.currentTrace = 0;
    this.render();
  }
  setCurrentTrace(t) {
    if (!this.dataset) return;
    this.currentTrace = Math.max(0, Math.min(this.dataset.numTraces - 1, Math.round(t)));
    this.render();
  }
  setAmp(min, max) { this.ampMin = min; this.ampMax = max; this.render(); }
  setColormap(name) { this.cmap = name; this.render(); }
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
  plot() { return { x: 56, y: 34, w: Math.max(1, this.w - 100), h: Math.max(1, this.h - 76) }; }
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
      const r = this.canvas.getBoundingClientRect();
      this.drag = { x: e.clientX - r.left, y: e.clientY - r.top, view: { ...this.view } };
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
      const p = this.plot(), dv = this.drag.view;
      const dt = (dv.t1 - dv.t0) / p.w, ds = (dv.s1 - dv.s0) / p.h;
      this.view.t0 = dv.t0 - (px - this.drag.x) * dt;
      this.view.t1 = dv.t1 - (px - this.drag.x) * dt;
      this.view.s0 = dv.s0 - (py - this.drag.y) * ds;
      this.view.s1 = dv.s1 - (py - this.drag.y) * ds;
      this.clamp();
      this.render();
    });
    addEventListener("mouseup", () => { this.drag = null; });
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
    const ctx = this.ctx;
    ctx.fillStyle = "#080c14";
    ctx.fillRect(0, 0, this.w || 1, this.h || 1);
    if (!this.dataset || !this.view) {
      ctx.fillStyle = "#7890aa"; ctx.textAlign = "center"; ctx.font = "14px Segoe UI";
      ctx.fillText("请先导入 .2B 数据", (this.w || 1) / 2, (this.h || 1) / 2);
      return;
    }
    const p = this.plot();
    this.drawImage(p);
    this.drawAxes(p);
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
    const ctx = this.ctx;
    ctx.strokeStyle = "#28364a"; ctx.strokeRect(p.x, p.y, p.w, p.h);
    ctx.fillStyle = "#7890aa"; ctx.font = "10px Consolas"; ctx.textAlign = "center";
    for (let i = 0; i <= 6; i++) {
      const f = i / 6, x = p.x + f * p.w, t = Math.round(this.view.t0 + f * (this.view.t1 - this.view.t0));
      ctx.fillText(t, x, p.y + p.h + 16);
    }
    ctx.textAlign = "right";
    for (let i = 0; i <= 6; i++) {
      const f = i / 6, y = p.y + f * p.h, s = Math.round(this.view.s0 + f * (this.view.s1 - this.view.s0));
      ctx.fillText(s, p.x - 7, y + 3);
    }
    ctx.textAlign = "center"; ctx.fillText("道号", p.x + p.w / 2, p.y + p.h + 31);
    ctx.save(); ctx.translate(15, p.y + p.h / 2); ctx.rotate(-Math.PI / 2); ctx.fillText("采样点 / 时间", 0, 0); ctx.restore();
  }
  drawTraceLine(p) {
    if (!this.markerLine || !this.dataset) return;
    const x = p.x + (this.currentTrace - this.view.t0) / (this.view.t1 - this.view.t0) * p.w;
    if (x < p.x || x > p.x + p.w) return;
    this.ctx.strokeStyle = "rgba(255,255,255,.85)";
    this.ctx.setLineDash([5, 4]);
    this.ctx.beginPath(); this.ctx.moveTo(x, p.y); this.ctx.lineTo(x, p.y + p.h); this.ctx.stroke();
    this.ctx.setLineDash([]);
  }
  drawColorbar(p) {
    const ctx = this.ctx, fn = maps[this.cmap] || maps.jet, x = p.x + p.w + 8, y = p.y + p.h * .2, h = p.h * .6;
    for (let i = 0; i < h; i++) {
      const [r, g, b] = fn(1 - i / h);
      ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fillRect(x, y + i, 12, 1);
    }
    ctx.strokeStyle = "#28364a"; ctx.strokeRect(x, y, 12, h);
    ctx.fillStyle = "#7890aa"; ctx.font = "9px Consolas"; ctx.textAlign = "left";
    ctx.fillText(this.ampMax.toFixed(1), x + 16, y + 8);
    ctx.fillText(this.ampMin.toFixed(1), x + 16, y + h);
  }
}

export function drawLine(canvas, values, opts = {}) {
  const rect = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  canvas.width = Math.max(1, rect.width * dpr); canvas.height = Math.max(1, rect.height * dpr);
  const ctx = canvas.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = rect.width, h = rect.height, m = { l: 48, r: 14, t: 22, b: 28 };
  ctx.fillStyle = "#080c14"; ctx.fillRect(0, 0, w, h);
  if (!values?.length) return;
  let min = Math.min(...values), max = Math.max(...values); if (min === max) { min--; max++; }
  ctx.strokeStyle = "#26364a"; ctx.lineWidth = .5;
  for (let i = 0; i <= 5; i++) { const y = m.t + i / 5 * (h - m.t - m.b); ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(w - m.r, y); ctx.stroke(); }
  ctx.strokeStyle = opts.color || "#4d8bff"; ctx.lineWidth = 1.4; ctx.beginPath();
  for (let i = 0; i < values.length; i++) {
    const x = m.l + i / Math.max(1, values.length - 1) * (w - m.l - m.r);
    const y = m.t + (1 - (values[i] - min) / (max - min)) * (h - m.t - m.b);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
  ctx.fillStyle = "#7890aa"; ctx.font = "10px Consolas"; ctx.textAlign = "right";
  ctx.fillText(max.toExponential(2), m.l - 6, m.t + 8);
  ctx.fillText(min.toExponential(2), m.l - 6, h - m.b);
  if (opts.title) { ctx.textAlign = "left"; ctx.fillText(opts.title, m.l, 14); }
}
