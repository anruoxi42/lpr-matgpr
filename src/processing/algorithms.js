export function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wlr = Math.cos(ang), wli = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      for (let j = 0; j < len / 2; j++) {
        const uR = re[i + j], uI = im[i + j];
        const vR = wr * re[i + j + len / 2] - wi * im[i + j + len / 2];
        const vI = wr * im[i + j + len / 2] + wi * re[i + j + len / 2];
        re[i + j] = uR + vR; im[i + j] = uI + vI;
        re[i + j + len / 2] = uR - vR; im[i + j + len / 2] = uI - vI;
        const nwr = wr * wlr - wi * wli; wi = wr * wli + wi * wlr; wr = nwr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function sinc(x) { return Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x); }
function safeNumber(v, fallback) { return Number.isFinite(Number(v)) ? Number(v) : fallback; }

export function hamming(n) {
  const w = new Float64Array(n);
  if (n <= 1) { if (n === 1) w[0] = 1; return w; }
  for (let i = 0; i < n; i++) w[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (n - 1));
  return w;
}

function linearInterpolate(xs, ys, x) {
  if (x <= xs[0]) return ys[0];
  const last = xs.length - 1;
  if (x >= xs[last]) return ys[last];
  let i = 0;
  while (i < last && xs[i + 1] < x) i++;
  const span = xs[i + 1] - xs[i] || 1;
  return ys[i] + (ys[i + 1] - ys[i]) * ((x - xs[i]) / span);
}

function firResponseMag(b, w) {
  let re = 0, im = 0;
  for (let i = 0; i < b.length; i++) {
    const a = -Math.PI * w * i;
    re += b[i] * Math.cos(a);
    im += b[i] * Math.sin(a);
  }
  return Math.hypot(re, im);
}

function solveLeastSquares(A, y) {
  const rows = A.length, cols = A[0]?.length || 0;
  const ata = Array.from({ length: cols }, () => new Float64Array(cols));
  const aty = new Float64Array(cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      aty[c] += A[r][c] * y[r];
      for (let k = 0; k < cols; k++) ata[c][k] += A[r][c] * A[r][k];
    }
  }
  for (let i = 0; i < cols; i++) ata[i][i] += 1e-9;
  for (let i = 0; i < cols; i++) {
    let pivot = i;
    for (let r = i + 1; r < cols; r++) if (Math.abs(ata[r][i]) > Math.abs(ata[pivot][i])) pivot = r;
    if (pivot !== i) { [ata[i], ata[pivot]] = [ata[pivot], ata[i]]; [aty[i], aty[pivot]] = [aty[pivot], aty[i]]; }
    const div = ata[i][i] || 1e-12;
    for (let c = i; c < cols; c++) ata[i][c] /= div;
    aty[i] /= div;
    for (let r = 0; r < cols; r++) {
      if (r === i) continue;
      const f = ata[r][i];
      for (let c = i; c < cols; c++) ata[r][c] -= f * ata[i][c];
      aty[r] -= f * aty[i];
    }
  }
  return aty;
}

export function fminsearch(fn, start, opts = {}) {
  const maxIter = opts.maxIter || 350;
  const tol = opts.tol || 1e-6;
  const n = start.length;
  const simplex = [Float64Array.from(start)];
  for (let i = 0; i < n; i++) {
    const p = Float64Array.from(start);
    p[i] = p[i] !== 0 ? p[i] * 1.05 : 0.00025;
    simplex.push(p);
  }
  let values = simplex.map(p => fn(Array.from(p)));
  for (let iter = 0; iter < maxIter; iter++) {
    const order = simplex.map((_, i) => i).sort((a, b) => values[a] - values[b]);
    const s2 = order.map(i => simplex[i]), v2 = order.map(i => values[i]);
    for (let i = 0; i < simplex.length; i++) { simplex[i] = s2[i]; values[i] = v2[i]; }
    const spread = Math.max(...values) - Math.min(...values);
    if (spread < tol) break;
    const centroid = new Float64Array(n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i][j] / n;
    const worst = simplex[n];
    const reflect = Float64Array.from(centroid, (c, j) => c + (c - worst[j]));
    const fr = fn(Array.from(reflect));
    if (fr < values[0]) {
      const expand = Float64Array.from(centroid, (c, j) => c + 2 * (reflect[j] - c));
      const fe = fn(Array.from(expand));
      simplex[n] = fe < fr ? expand : reflect;
      values[n] = Math.min(fe, fr);
    } else if (fr < values[n - 1]) {
      simplex[n] = reflect; values[n] = fr;
    } else {
      const contract = Float64Array.from(centroid, (c, j) => c + 0.5 * (worst[j] - c));
      const fc = fn(Array.from(contract));
      if (fc < values[n]) {
        simplex[n] = contract; values[n] = fc;
      } else {
        for (let i = 1; i <= n; i++) {
          for (let j = 0; j < n; j++) simplex[i][j] = simplex[0][j] + 0.5 * (simplex[i][j] - simplex[0][j]);
          values[i] = fn(Array.from(simplex[i]));
        }
      }
    }
  }
  const best = values.indexOf(Math.min(...values));
  return Array.from(simplex[best]);
}

export function firF2(n, f, m, gridN = 512, rampN = null, window = null) {
  if (f.length !== m.length || f.length < 2 || f[0] !== 0 || f[f.length - 1] !== 1) return new Float64Array();
  for (let i = 1; i < f.length; i++) if (f[i] < f[i - 1]) return new Float64Array();
  gridN = nextPow2(Math.max(gridN, Math.ceil((n + 1) / 2)));
  rampN = rampN ?? gridN / 20;
  f = Array.from(f); m = Array.from(m);
  if (rampN > 0) {
    const base = Array.from(f);
    for (let i = 0; i < f.length - 1; i++) {
      if (f[i + 1] === f[i]) {
        f[i] -= rampN / gridN / 2;
        f[i + 1] += rampN / gridN / 2;
      }
    }
    f[0] = 0; f[f.length - 1] = 1;
    for (let i = 0; i < f.length - 1; i++) {
      if (f[i + 1] < f[i]) {
        f[i] = (base[i] + base[i + 1]) / 2;
        f[i + 1] = f[i];
      }
    }
  }
  const grid = new Float64Array(gridN + 1);
  for (let i = 0; i <= gridN; i++) grid[i] = linearInterpolate(f, m, i / gridN);
  const len = 2 * gridN;
  const re = new Float64Array(len), im = new Float64Array(len);
  for (let i = 0; i <= gridN; i++) re[i] = grid[i];
  for (let i = 1; i < gridN; i++) re[gridN + i] = grid[gridN - i];
  fft(re, im, true);
  const mid = (n + 1) / 2;
  const b = new Float64Array(n + 1);
  let p = 0;
  for (let i = len - Math.floor(mid); i < len; i++) b[p++] = re[i];
  for (let i = 0; p < b.length; i++) b[p++] = re[i];
  const win = window || hamming(n + 1);
  for (let i = 0; i < b.length; i++) b[i] *= win[i];
  return b;
}

export function firF1(n, w, type = "", window = null, scale = "scale") {
  const edges = (Array.isArray(w) || ArrayBuffer.isView(w)) ? Array.from(w) : [w];
  const clean = edges.map(v => clamp(Number(v), 1e-6, 0.999999)).sort((a, b) => a - b);
  let passStartsAtDc;
  const t = String(type || "").toLowerCase();
  if (!t) passStartsAtDc = clean.length === 1;
  else if (t === "low") passStartsAtDc = true;
  else if (t === "high" || t === "pass" || t === "dc-0") passStartsAtDc = false;
  else if (t === "stop" || t === "dc-1") passStartsAtDc = true;
  else passStartsAtDc = clean.length === 1;
  const bands = clean.length + 1;
  const f = new Array(2 * bands);
  f[0] = 0; f[f.length - 1] = 1;
  for (let i = 0; i < clean.length; i++) { f[2 * i + 1] = clean[i]; f[2 * i + 2] = clean[i]; }
  const m = new Array(2 * bands);
  for (let band = 0; band < bands; band++) {
    const pass = passStartsAtDc ? band % 2 === 0 : band % 2 === 1;
    m[2 * band] = pass ? 1 : 0;
    m[2 * band + 1] = pass ? 1 : 0;
  }
  if (n % 2 === 1 && m[m.length - 1] === 1) n += 1;
  const b = firF2(n, f, m, 2 * nextPow2(n), 2, window);
  if (scale !== "noscale" && b.length) {
    const w0 = m[0] === 1 ? (f[1] - f[0]) / 2 : f[2] + (f[3] - f[2]) / 2;
    const mag = firResponseMag(b, w0);
    if (mag > 1e-12) for (let i = 0; i < b.length; i++) b[i] /= mag;
  }
  return b;
}

function zeroPhaseLine(line, b) {
  const n = line.length, nfft = nextPow2(Math.max(2, 2 * n));
  const re = new Float64Array(nfft), im = new Float64Array(nfft);
  const hr = new Float64Array(nfft), hi = new Float64Array(nfft);
  re.set(line); hr.set(b.subarray ? b.subarray(0, Math.min(b.length, nfft)) : b.slice(0, nfft));
  fft(re, im); fft(hr, hi);
  for (let i = 0; i < nfft; i++) {
    const h2 = hr[i] * hr[i] + hi[i] * hi[i];
    re[i] *= h2; im[i] *= h2;
  }
  fft(re, im, true);
  return re.slice(0, n);
}

export function zeroPhaseFirFilter(d, nt, ns, b, axis = "time") {
  const o = new Float32Array(d.length);
  if (axis === "scan") {
    for (let s = 0; s < ns; s++) {
      const line = new Float64Array(nt);
      for (let t = 0; t < nt; t++) line[t] = d[t * ns + s];
      const y = zeroPhaseLine(line, b);
      for (let t = 0; t < nt; t++) o[t * ns + s] = y[t];
    }
  } else {
    for (let t = 0; t < nt; t++) {
      const y = zeroPhaseLine(d.subarray(t * ns, t * ns + ns), b);
      for (let s = 0; s < ns; s++) o[t * ns + s] = y[s];
    }
  }
  return { data: o, numTraces: nt, numSamples: ns };
}

export function spectrum(trace) {
  const n = nextPow2(trace.length), re = new Float64Array(n), im = new Float64Array(n);
  re.set(trace); fft(re, im);
  const out = new Float32Array(n / 2);
  for (let i = 0; i < out.length; i++) out[i] = Math.hypot(re[i], im[i]) / n;
  return out;
}

export function hilbert(trace, padFactor = 1) {
  const n = nextPow2(Math.max(trace.length, Math.ceil(trace.length * padFactor))), re = new Float64Array(n), im = new Float64Array(n);
  re.set(trace); fft(re, im);
  if (n % 2 === 0) {
    for (let i = 1; i < n / 2; i++) { re[i] *= 2; im[i] *= 2; }
    for (let i = n / 2 + 1; i < n; i++) { re[i] = 0; im[i] = 0; }
  } else {
    for (let i = 1; i <= (n - 1) / 2; i++) { re[i] *= 2; im[i] *= 2; }
    for (let i = (n + 1) / 2; i < n; i++) { re[i] = 0; im[i] = 0; }
  }
  fft(re, im, true);
  return { re: re.slice(0, trace.length), im: im.slice(0, trace.length) };
}
export function removeDC(d, nt, ns) {
  const o = new Float32Array(d.length);
  for (let t = 0; t < nt; t++) {
    let mean = 0; for (let s = 0; s < ns; s++) mean += d[t * ns + s]; mean /= ns;
    for (let s = 0; s < ns; s++) o[t * ns + s] = d[t * ns + s] - mean;
  }
  return { data: o, numTraces: nt, numSamples: ns };
}
export function trimTime(d, nt, ns, start = 0, end = ns - 1) {
  start = Math.max(0, Math.floor(start)); end = Math.min(ns - 1, Math.floor(end));
  const nns = Math.max(1, end - start + 1), o = new Float32Array(nt * nns);
  for (let t = 0; t < nt; t++) for (let s = 0; s < nns; s++) o[t * nns + s] = d[t * ns + start + s];
  return { data: o, numTraces: nt, numSamples: nns, sampleStart: start };
}
export function signalPosition(d, nt, ns, shift = 0) {
  const start = Math.max(0, Math.floor(shift));
  if (start <= 0) return { data: new Float32Array(d), numTraces: nt, numSamples: ns, sampleStart: 0 };
  const nns = Math.max(1, ns - start), o = new Float32Array(nt * nns);
  for (let t = 0; t < nt; t++) for (let s = 0; s < nns; s++) o[t * nns + s] = d[t * ns + start + s];
  return { data: o, numTraces: nt, numSamples: nns, sampleStart: start, timeZeroSample: start };
}
export function removeBadTraces(d, nt, ns, ranges = "") {
  const remove = new Set();
  for (const part of String(ranges).split(",")) {
    const m = part.trim().match(/^(\d+)\s*[-~]\s*(\d+)$/);
    if (m) for (let i = +m[1]; i <= +m[2]; i++) remove.add(i);
    else if (/^\d+$/.test(part.trim())) remove.add(+part.trim());
  }
  const keep = []; for (let i = 0; i < nt; i++) if (!remove.has(i)) keep.push(i);
  const o = new Float32Array(keep.length * ns);
  keep.forEach((k, i) => o.set(d.subarray(k * ns, k * ns + ns), i * ns));
  return { data: o, numTraces: keep.length, numSamples: ns };
}
export function backgroundRemove(d, nt, ns) {
  const bg = new Float64Array(ns), o = new Float32Array(d.length);
  for (let s = 0; s < ns; s++) { for (let t = 0; t < nt; t++) bg[s] += d[t * ns + s]; bg[s] /= nt; }
  for (let t = 0; t < nt; t++) for (let s = 0; s < ns; s++) o[t * ns + s] = d[t * ns + s] - bg[s];
  return { data: o, numTraces: nt, numSamples: ns };
}
export function slidingBackground(d, nt, ns, width = 25, mode = "remove") {
  const o = new Float32Array(d.length);
  const h = Math.max(1, Math.min(Math.floor(nt / 2) || 1, Math.floor(Number(width || 25) / 2)));
  const firstEnd = Math.max(1, Math.min(nt, h));
  const lastStart = Math.max(0, nt - firstEnd);
  for (let t = 0; t < nt; t++) {
    let a, b;
    if (t < h) { a = 0; b = firstEnd - 1; }
    else if (t >= nt - h) { a = lastStart; b = nt - 1; }
    else { a = t - h; b = t + h; }
    const c = Math.max(1, b - a + 1);
    for (let s = 0; s < ns; s++) {
      let sum = 0;
      for (let k = a; k <= b; k++) sum += d[k * ns + s];
      const bg = sum / c;
      o[t * ns + s] = mode === "retain" ? bg : d[t * ns + s] - bg;
    }
  }
  return { data: o, numTraces: nt, numSamples: ns };
}

export function agc(d, nt, ns, winOrParams = 50, gaussian = false) {
  const params = typeof winOrParams === "object" ? winOrParams : { windowSamples: winOrParams, gaussian };
  const dtNs = safeNumber(params.dtNs, 0.625);
  const windowSamples = params.windowNs != null ? Math.floor(Number(params.windowNs) / dtNs) : Math.floor(Number(params.windowSamples ?? params.window ?? 50));
  const full = clamp(windowSamples || 1, 1, Math.max(1, Math.floor(ns / 2)));
  const h = Math.max(1, Math.round(full / 2));
  const useGaussian = !!params.gaussian;
  const o = new Float32Array(d.length);
  if (useGaussian) {
    const eps = Math.sqrt(Math.abs(Math.log(safeNumber(params.eps, 5e-7))));
    const u2 = (eps / Math.max(1, full)) ** 2;
    const w = new Float64Array(full);
    for (let i = 0; i < full; i++) w[i] = Math.exp(-(u2 * i * i));
    for (let t = 0; t < nt; t++) {
      for (let s = 0; s < ns; s++) {
        let sum = d[t * ns + s] ** 2;
        for (let j = 1; j < full; j++) {
          if (s - j >= 0) sum += w[j] * d[t * ns + s - j] ** 2;
          if (s + j < ns) sum += w[j] * d[t * ns + s + j] ** 2;
        }
        o[t * ns + s] = sum > 1e-24 ? d[t * ns + s] / Math.sqrt(sum) : 0;
      }
    }
    return { data: o, numTraces: nt, numSamples: ns };
  }
  for (let t = 0; t < nt; t++) {
    const prefix = new Float64Array(ns + 1);
    for (let s = 0; s < ns; s++) prefix[s + 1] = prefix[s] + d[t * ns + s] ** 2;
    for (let s = 0; s < ns; s++) {
      const a = Math.max(0, s - h), b = Math.min(ns - 1, s + h);
      const count = b - a + 1;
      const rms = Math.sqrt((prefix[b + 1] - prefix[a]) / count);
      o[t * ns + s] = rms > 1e-12 ? d[t * ns + s] / rms : 0;
    }
  }
  return { data: o, numTraces: nt, numSamples: ns };
}

export function gagc(d, nt, ns, params = {}) {
  return agc(d, nt, ns, { ...params, gaussian: true });
}
export function equalize(d, nt, ns) {
  const energies = new Float64Array(nt); let target = 0;
  for (let t = 0; t < nt; t++) { for (let s = 0; s < ns; s++) energies[t] += Math.abs(d[t * ns + s]); target += energies[t]; }
  target /= nt;
  const o = new Float32Array(d.length);
  for (let t = 0; t < nt; t++) {
    const scale = energies[t] > 1e-12 ? target / energies[t] : 0;
    for (let s = 0; s < ns; s++) o[t * ns + s] = d[t * ns + s] * scale;
  }
  return { data: o, numTraces: nt, numSamples: ns };
}
function attenuationCurve(d, nt, ns, mode = "power", statistic = "median") {
  const out = new Float64Array(ns);
  const vals = new Float64Array(nt * ns);
  for (let t = 0; t < nt; t++) {
    const h = hilbert(d.subarray(t * ns, t * ns + ns), 3);
    for (let s = 0; s < ns; s++) vals[t * ns + s] = mode === "power" ? (h.re[s] ** 2 + h.im[s] ** 2) : Math.hypot(h.re[s], h.im[s]);
  }
  for (let s = 0; s < ns; s++) {
    const col = new Float64Array(nt);
    let sum = 0;
    for (let t = 0; t < nt; t++) { col[t] = vals[t * ns + s]; sum += col[t]; }
    out[s] = statistic === "mean" ? sum / Math.max(1, nt) : medianTyped(col);
  }
  return out;
}

function estimatePower(d, nt, ns, dtNs) {
  const att = attenuationCurve(d, nt, ns, "power");
  let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
  for (let s = 1; s < ns; s++) {
    const tt = s * dtNs, y = Math.max(att[s], 1e-18);
    if (!Number.isFinite(y) || y <= 0) continue;
    const x = Math.log10(tt), ly = Math.log10(y);
    sx += x; sy += ly; sxx += x * x; sxy += x * ly; n++;
  }
  const slope = n > 1 ? (n * sxy - sx * sy) / Math.max(1e-12, n * sxx - sx * sx) : -2.5;
  return clamp(Math.abs(slope) - 1, 0, 8);
}

export function powerGain(d, nt, ns, power = 1.5, dtNs = 0.625) {
  if (typeof power === "object") {
    dtNs = safeNumber(power.dtNs, dtNs);
    power = power.power ?? "auto";
  }
  if (power === "auto" || power == null || power === "") power = estimatePower(d, nt, ns, dtNs);
  power = safeNumber(power, 1.5);
  const o = new Float32Array(d.length);
  const gain = new Float64Array(ns);
  for (let s = 0; s < ns; s++) {
    const tt = Math.max(dtNs, (s + 1) * dtNs);
    gain[s] = tt ** power;
  }
  let minIn = Infinity, maxIn = -Infinity, minOut = Infinity, maxOut = -Infinity;
  for (let i = 0; i < d.length; i++) { minIn = Math.min(minIn, d[i]); maxIn = Math.max(maxIn, d[i]); }
  for (let t = 0; t < nt; t++) for (let s = 0; s < ns; s++) {
    const v = d[t * ns + s] * gain[s];
    o[t * ns + s] = v;
    minOut = Math.min(minOut, v); maxOut = Math.max(maxOut, v);
  }
  const scale = (maxOut > minOut) ? (maxIn - minIn) / (maxOut - minOut) : 1;
  for (let i = 0; i < o.length; i++) o[i] *= scale;
  return { data: o, numTraces: nt, numSamples: ns, power, scale };
}

export function amplitudeGain(d, nt, ns, params = {}) {
  const dtNs = safeNumber(params.dtNs, 0.625);
  const order = clamp(Math.floor(safeNumber(params.order, 3)), 1, 5);
  const tt = new Float64Array(ns);
  for (let s = 0; s < ns; s++) tt[s] = s * dtNs;
  const decay = attenuationCurve(d, nt, ns, "amplitude", params.curve === "mean" ? "mean" : "median");
  const objective = a => {
    const A = [];
    const y = [];
    for (let s = 1; s < ns; s++) {
      const row = [];
      for (let j = 0; j < a.length; j++) row.push(Math.exp(-Math.abs(a[j]) * tt[s]));
      A.push(row); y.push(Math.log10(Math.max(decay[s], 1e-18)));
    }
    const c = solveLeastSquares(A, y);
    let err = 0;
    for (let i = 0; i < A.length; i++) {
      let pred = 0;
      for (let j = 0; j < c.length; j++) pred += A[i][j] * c[j];
      const e = y[i] - pred;
      err += e * e;
    }
    return Math.sqrt(err / Math.max(1, A.length));
  };
  const start = Array.from({ length: order + 1 }, (_, i) => i);
  const a = fminsearch(objective, start, { maxIter: 150 * (order + 1), tol: 1e-5 }).map(Math.abs);
  const A = [], y = [];
  for (let s = 0; s < ns; s++) {
    A.push(a.map(v => Math.exp(-v * tt[s])));
    y.push(Math.log10(Math.max(decay[s], 1e-18)));
  }
  const c = solveLeastSquares(A, y);
  const model = new Float64Array(ns);
  for (let s = 0; s < ns; s++) {
    let pred = 0;
    for (let j = 0; j < c.length; j++) pred += A[s][j] * c[j];
    model[s] = Math.max(1e-18, 10 ** pred);
  }
  const max = Math.max(...model), o = new Float32Array(d.length);
  for (let s = 0; s < ns; s++) {
    const g = model[s] > 1e-18 ? max / model[s] : 1;
    for (let t = 0; t < nt; t++) o[t * ns + s] = d[t * ns + s] * g;
  }
  return { data: o, numTraces: nt, numSamples: ns, decayModel: model, order };
}

export function dewow(d, nt, ns) {
  let nf = Math.floor(0.9 * ns);
  if (nf % 2 !== 0) nf += 1;
  const b = firF1(nf, 0.02, "high");
  return zeroPhaseFirFilter(d, nt, ns, b, "time");
}

function filterSpec(type, lo, hi, sampleRate) {
  const nyq = sampleRate / 2;
  const kind = String(type || "bp").toLowerCase();
  if (kind === "lp" || kind === "low") return { w: clamp(hi / nyq, 1e-6, 0.999999), firType: "low" };
  if (kind === "hp" || kind === "high") return { w: clamp(lo / nyq, 1e-6, 0.999999), firType: "high" };
  const w = [clamp(Math.min(lo, hi) / nyq, 1e-6, 0.999999), clamp(Math.max(lo, hi) / nyq, 1e-6, 0.999999)];
  if (kind === "bs" || kind === "stop" || kind === "br") return { w, firType: "stop" };
  return { w, firType: "" };
}

export function freqFilter(d, nt, ns, type = "bp", lo = 20e6, hi = 200e6, sampleRateOrParams = 1e9) {
  const params = typeof sampleRateOrParams === "object" ? sampleRateOrParams : { sampleRateHz: sampleRateOrParams };
  const sampleRate = safeNumber(params.sampleRateHz, params.dtNs ? 1 / (params.dtNs * 1e-9) : 1e9);
  const spec = filterSpec(type, lo, hi, sampleRate);
  const nf = Math.max(4, Math.floor(0.75 * ns));
  const b = firF1(nf, spec.w, spec.firType);
  return zeroPhaseFirFilter(d, nt, ns, b, "time");
}

export function kFilter(d, nt, ns, type = "bp", lo = 0.2, hi = 5, dxM = 0.05) {
  const kn = 1 / (2 * Math.max(Math.abs(dxM), 1e-9));
  const spec = filterSpec(type, Math.abs(lo), Math.abs(hi), 2 * kn);
  const nf = Math.max(4, Math.floor(0.75 * nt));
  const b = firF1(nf, spec.w, spec.firType);
  return zeroPhaseFirFilter(d, nt, ns, b, "scan");
}

function antiAliasLine(line, ratio, order) {
  if (ratio >= 1) return line;
  const nf = Math.max(4, 2 * order + 1);
  const b = firF1(nf, clamp(ratio, 1e-6, 0.999999), "low");
  return zeroPhaseLine(line, b);
}

export function sincResampleLine(line, newCount, order = 15) {
  const n = line.length;
  newCount = Math.max(2, Math.floor(newCount));
  const ratio = newCount / Math.max(1, n);
  const src = antiAliasLine(line, ratio, order);
  const out = new Float32Array(newCount);
  if (newCount === 1) { out[0] = src[0] || 0; return out; }
  for (let j = 0; j < newCount; j++) {
    const x = j * (n - 1) / (newCount - 1);
    const i0 = Math.floor(x);
    let sum = 0;
    for (let k = i0 - order; k <= i0 + order; k++) {
      if (k < 0 || k >= n) continue;
      const u = x - k;
      const w = sinc(u) * (0.5 + 0.5 * Math.cos(Math.PI * u / (order + 0.5)));
      sum += src[k] * w;
    }
    out[j] = sum;
  }
  return out;
}

export function resample(d, nt, ns, axis = "time", newCount = ns, params = {}) {
  newCount = Math.max(2, Math.floor(newCount));
  const order = Math.max(3, Math.floor(safeNumber(params.order, 15)));
  if (axis === "scan") {
    const o = new Float32Array(newCount * ns);
    for (let s = 0; s < ns; s++) {
      const line = new Float32Array(nt);
      for (let t = 0; t < nt; t++) line[t] = d[t * ns + s];
      const y = sincResampleLine(line, newCount, order);
      for (let t = 0; t < newCount; t++) o[t * ns + s] = y[t];
    }
    return { data: o, numTraces: newCount, numSamples: ns, dxM: params.dxM ? params.dxM * nt / newCount : undefined };
  }
  const o = new Float32Array(nt * newCount);
  for (let t = 0; t < nt; t++) {
    const y = sincResampleLine(d.subarray(t * ns, t * ns + ns), newCount, order);
    o.set(y, t * newCount);
  }
  return { data: o, numTraces: nt, numSamples: newCount, dtNs: params.dtNs ? params.dtNs * ns / newCount : undefined };
}

function fft2D(re, im, rows, cols, inverse = false) {
  const tr = new Float64Array(Math.max(rows, cols)), ti = new Float64Array(Math.max(rows, cols));
  for (let r = 0; r < rows; r++) {
    tr.fill(0, 0, cols); ti.fill(0, 0, cols);
    for (let c = 0; c < cols; c++) { tr[c] = re[r * cols + c]; ti[c] = im[r * cols + c]; }
    fft(tr.subarray(0, cols), ti.subarray(0, cols), inverse);
    for (let c = 0; c < cols; c++) { re[r * cols + c] = tr[c]; im[r * cols + c] = ti[c]; }
  }
  for (let c = 0; c < cols; c++) {
    tr.fill(0, 0, rows); ti.fill(0, 0, rows);
    for (let r = 0; r < rows; r++) { tr[r] = re[r * cols + c]; ti[r] = im[r * cols + c]; }
    fft(tr.subarray(0, rows), ti.subarray(0, rows), inverse);
    for (let r = 0; r < rows; r++) { re[r * cols + c] = tr[r]; im[r * cols + c] = ti[r]; }
  }
}

function fftShift2(re, im, rows, cols) {
  const rr = new Float64Array(re.length), ii = new Float64Array(im.length);
  const rh = Math.floor(rows / 2), ch = Math.floor(cols / 2);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const nr = (r + rh) % rows, nc = (c + ch) % cols;
    rr[nr * cols + nc] = re[r * cols + c];
    ii[nr * cols + nc] = im[r * cols + c];
  }
  re.set(rr); im.set(ii);
}

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].k ?? poly[i].x, yi = poly[i].f ?? poly[i].y;
    const xj = poly[j].k ?? poly[j].x, yj = poly[j].f ?? poly[j].y;
    const hit = ((yi > y) !== (yj > y)) && x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function fkMaskValue(params, f, k, r, c, rows, cols) {
  const mode = String(params.mode || "velocity-fan");
  const action = String(params.action || "pass");
  let pass = true;
  if (mode === "polygon") {
    const poly = Array.isArray(params.polygon) ? params.polygon : [];
    pass = poly.length >= 3 ? pointInPolygon(k, Math.abs(f), poly) : true;
  } else if (mode === "up-dip") {
    pass = (r < rows / 2 && c < cols / 2) || (r >= rows / 2 && c >= cols / 2);
  } else if (mode === "down-dip") {
    pass = (r < rows / 2 && c >= cols / 2) || (r >= rows / 2 && c < cols / 2);
  } else {
    const vr = params.velocityRange || {};
    const minV = Math.max(1e-9, safeNumber(vr.min ?? params.vMin, 0.03));
    const maxV = Math.max(minV, safeNumber(vr.max ?? params.vMax, 0.3));
    const v = Math.abs(k) > 1e-12 ? Math.abs(f / k) : Infinity;
    pass = v >= minV && v <= maxV;
  }
  return action === "stop" ? !pass : pass;
}

export function fkFilter(d, nt, ns, params = {}) {
  const dtNs = safeNumber(params.dtNs ?? params.dt, 0.625);
  const dxM = safeNumber(params.dxM ?? params.dx, 0.05);
  const rows = nextPow2(2 * ns), cols = nextPow2(2 * nt);
  const re = new Float64Array(rows * cols), im = new Float64Array(rows * cols);
  for (let t = 0; t < nt; t++) for (let s = 0; s < ns; s++) re[s * cols + t] = d[t * ns + s];
  fft2D(re, im, rows, cols);
  fftShift2(re, im, rows, cols);
  for (let r = 0; r < rows; r++) {
    const f = (r - rows / 2) / (rows * dtNs);
    for (let c = 0; c < cols; c++) {
      const k = (c - cols / 2) / (cols * Math.max(Math.abs(dxM), 1e-9));
      if (!fkMaskValue(params, f, k, r, c, rows, cols)) {
        re[r * cols + c] = 0; im[r * cols + c] = 0;
      }
    }
  }
  fftShift2(re, im, rows, cols);
  fft2D(re, im, rows, cols, true);
  const o = new Float32Array(nt * ns);
  for (let t = 0; t < nt; t++) for (let s = 0; s < ns; s++) o[t * ns + s] = re[s * cols + t];
  return { data: o, numTraces: nt, numSamples: ns };
}

export function fkSpectrum(d, nt, ns, dtNs = 0.625, dxM = 0.05, maxSize = 256) {
  const st = Math.max(1, Math.ceil(nt / maxSize));
  const ss = Math.max(1, Math.ceil(ns / maxSize));
  const nt2 = Math.ceil(nt / st), ns2 = Math.ceil(ns / ss);
  const rows = nextPow2(2 * ns2), cols = nextPow2(2 * nt2);
  const re = new Float64Array(rows * cols), im = new Float64Array(rows * cols);
  for (let t = 0; t < nt2; t++) for (let s = 0; s < ns2; s++) re[s * cols + t] = d[Math.min(nt - 1, t * st) * ns + Math.min(ns - 1, s * ss)];
  fft2D(re, im, rows, cols);
  fftShift2(re, im, rows, cols);
  const width = Math.min(maxSize, cols), height = Math.min(maxSize, rows);
  const values = new Float32Array(width * height);
  let min = Infinity, max = -Infinity;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const r = Math.floor(y / height * rows), c = Math.floor(x / width * cols);
    const v = Math.log10(1 + Math.hypot(re[r * cols + c], im[r * cols + c]));
    values[y * width + x] = v; min = Math.min(min, v); max = Math.max(max, v);
  }
  const range = max - min || 1;
  for (let i = 0; i < values.length; i++) values[i] = (values[i] - min) / range;
  return { values, width, height, fMaxGHz: 1 / (2 * dtNs), kMax: 1 / (2 * Math.max(Math.abs(dxM), 1e-9)) };
}

export function simpleMigration(d, nt, ns, velocity = 0.1, dt = 0.625, dx = 0.05) {
  const o = new Float32Array(d.length), radius = Math.max(1, Math.round(velocity * dt / Math.max(dx, 1e-6) * 3));
  for (let t = 0; t < nt; t++) for (let s = 0; s < ns; s++) {
    let sum = 0, c = 0;
    for (let k = -radius; k <= radius; k++) {
      const ti = t + k, si = Math.round(Math.sqrt(s * s + (2 * dx * k / Math.max(velocity * dt, 1e-6)) ** 2));
      if (ti >= 0 && ti < nt && si >= 0 && si < ns) { sum += d[ti * ns + si]; c++; }
    }
    o[t * ns + s] = c ? sum / c : 0;
  }
  return { data: o, numTraces: nt, numSamples: ns };
}
export function timeDepth(d, nt, ns, velocity = 0.1, dt = 0.625, dz = 0.02) {
  const maxDepth = velocity * (ns - 1) * dt / 2, newNs = Math.max(2, Math.ceil(maxDepth / dz));
  const o = new Float32Array(nt * newNs);
  for (let t = 0; t < nt; t++) for (let z = 0; z < newNs; z++) {
    const sample = (z * dz) * 2 / (velocity * dt), i = Math.floor(sample), f = sample - i;
    o[t * newNs + z] = i >= 0 && i < ns - 1 ? d[t * ns + i] * (1 - f) + d[t * ns + i + 1] * f : 0;
  }
  return { data: o, numTraces: nt, numSamples: newNs, depthStep: dz };
}
export function instantaneous(d, nt, ns, attr = "amplitude", params = {}) {
  if (typeof attr === "object") { params = attr; attr = params.attr || "amplitude"; }
  const dtNs = safeNumber(params.dtNs, 0.625);
  const kind = String(attr || "amplitude").toLowerCase();
  const o = new Float32Array(d.length);
  for (let t = 0; t < nt; t++) {
    const h = hilbert(d.subarray(t * ns, t * ns + ns), 3);
    const phase = new Float64Array(ns);
    for (let s = 0; s < ns; s++) phase[s] = Math.atan2(h.im[s], h.re[s]);
    for (let s = 1; s < ns; s++) {
      let dp = phase[s] - phase[s - 1];
      if (dp > Math.PI) phase[s] -= 2 * Math.PI;
      else if (dp < -Math.PI) phase[s] += 2 * Math.PI;
    }
    for (let s = 1; s < ns; s++) {
      while (phase[s] - phase[s - 1] > Math.PI) phase[s] -= 2 * Math.PI;
      while (phase[s] - phase[s - 1] < -Math.PI) phase[s] += 2 * Math.PI;
    }
    for (let s = 0; s < ns; s++) {
      if (kind === "phase" || kind === "atan2") o[t * ns + s] = Math.atan2(h.im[s], h.re[s]);
      else if (kind === "atan") o[t * ns + s] = Math.atan(h.im[s] / (Math.abs(h.re[s]) > 1e-18 ? h.re[s] : 1e-18));
      else if (kind === "unwrap" || kind === "unwrapped") o[t * ns + s] = phase[s];
      else if ((kind === "frequency" || kind === "ifreq") && s > 0) o[t * ns + s] = (phase[s] - phase[s - 1]) / (2 * Math.PI * dtNs);
      else o[t * ns + s] = Math.hypot(h.re[s], h.im[s]);
    }
  }
  return { data: o, numTraces: nt, numSamples: ns };
}
export function centroidFrequency(d, nt, ns) {
  const o = new Float32Array(nt * ns);
  for (let t = 0; t < nt; t++) {
    const sp = spectrum(d.subarray(t * ns, t * ns + ns));
    let num = 0, den = 0; for (let i = 0; i < sp.length; i++) { num += i * sp[i]; den += sp[i]; }
    const c = den ? num / den : 0; for (let s = 0; s < ns; s++) o[t * ns + s] = c;
  }
  return { data: o, numTraces: nt, numSamples: ns };
}

function smoothSamples(d, nt, ns, width = 17) {
  const o = new Float32Array(d.length), h = Math.max(1, Math.floor(width / 2));
  for (let t = 0; t < nt; t++) {
    let sum = 0, count = 0;
    for (let s = 0; s < ns; s++) {
      while (count < Math.min(ns, s + h + 1)) { sum += d[t * ns + count]; count++; }
      const first = Math.max(0, s - h);
      const last = Math.min(ns - 1, s + h);
      if (s > 0) {
        const prevFirst = Math.max(0, s - 1 - h);
        if (prevFirst < first) sum -= d[t * ns + prevFirst];
      }
      o[t * ns + s] = sum / (last - first + 1);
    }
  }
  return o;
}

function smoothTraces(d, nt, ns, width = 13) {
  const o = new Float32Array(d.length), h = Math.max(1, Math.floor(width / 2));
  for (let s = 0; s < ns; s++) {
    let sum = 0, count = 0;
    for (let t = 0; t < nt; t++) {
      while (count < Math.min(nt, t + h + 1)) { sum += d[count * ns + s]; count++; }
      const first = Math.max(0, t - h);
      const last = Math.min(nt - 1, t + h);
      if (t > 0) {
        const prevFirst = Math.max(0, t - 1 - h);
        if (prevFirst < first) sum -= d[prevFirst * ns + s];
      }
      o[t * ns + s] = sum / (last - first + 1);
    }
  }
  return o;
}

function smoothLine(line, width = 61) {
  const n = line.length, out = new Float32Array(n), h = Math.max(1, Math.floor(width / 2));
  for (let i = 0; i < n; i++) {
    let sum = 0, count = 0;
    for (let k = i - h; k <= i + h; k++) {
      const j = Math.max(0, Math.min(n - 1, k));
      sum += line[j]; count++;
    }
    out[i] = sum / count;
  }
  return out;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const a = Array.from(values).sort((x, y) => x - y);
  const i = Math.max(0, Math.min(a.length - 1, Math.floor((a.length - 1) * p)));
  return a[i];
}

function medianTyped(line) {
  return percentile(line, 0.5);
}

export function geologicModel(d, nt, ns, params = {}) {
  const dt = Number(params.dt) || 0.3125;
  const dx = Number(params.dx) || 0.05;
  const velocity = Number(params.velocity) || 0.1;
  const loMHz = Number(params.loMHz) || 20;
  const hiMHz = Number(params.hiMHz) || 900;
  const bgWidth = Number(params.bgWidth) || 25;
  const agcWindow = Number(params.agcWindow) || 80;
  const modelDepthMax = Number(params.modelDepthMax) || 24;
  const sampleRate = 1 / (dt * 1e-9);

  let r = removeDC(d, nt, ns).data;
  r = freqFilter(r, nt, ns, "bp", loMHz * 1e6, hiMHz * 1e6, sampleRate).data;
  r = backgroundRemove(r, nt, ns).data;
  r = slidingBackground(r, nt, ns, bgWidth, "remove").data;
  r = agc(r, nt, ns, agcWindow, true).data;

  const clip = Number(params.clip) || 4;
  for (let i = 0; i < r.length; i++) {
    if (r[i] > clip) r[i] = clip;
    else if (r[i] < -clip) r[i] = -clip;
  }

  const energy = new Float32Array(r.length);
  for (let i = 0; i < r.length; i++) energy[i] = Math.abs(r[i]);
  const energySmoothed = smoothTraces(smoothSamples(energy, nt, ns, 17), nt, ns, 13);

  const depthStep = velocity * dt / 2;
  const startSample = Math.max(0, Math.floor((Number(params.startDepth) || 1.5) / depthStep));
  const endSample = Math.min(ns - 2, Math.ceil((Number(params.endDepth) || Math.min(24, (ns - 1) * depthStep)) / depthStep));
  const minSepSamples = Math.max(1, Math.round((Number(params.minHorizonSeparation) || 0.8) / depthStep));
  const peaks = [];
  for (let t = 0; t < nt; t++) {
    const candidates = [];
    for (let s = startSample + 1; s < endSample - 1; s++) {
      const v = energySmoothed[t * ns + s];
      if (v > energySmoothed[t * ns + s - 1] && v >= energySmoothed[t * ns + s + 1]) candidates.push({ s, v });
    }
    candidates.sort((a, b) => b.v - a.v);
    const chosen = [];
    for (const c of candidates) {
      if (chosen.every(p => Math.abs(p.s - c.s) >= minSepSamples)) chosen.push(c);
      if (chosen.length >= 4) break;
    }
    for (const c of chosen) peaks.push({ t, depth: c.s * depthStep, strength: c.v });
  }

  const binSize = 0.5, binStart = startSample * depthStep, binEnd = endSample * depthStep;
  const binCount = Math.max(1, Math.ceil((binEnd - binStart) / binSize));
  const hist = new Float32Array(binCount);
  for (const p of peaks) {
    const bi = Math.floor((p.depth - binStart) / binSize);
    if (bi >= 0 && bi < binCount) hist[bi] += p.strength;
  }

  const histThreshold = percentile(hist, 0.72);
  const clusters = [];
  for (let i = 1; i < binCount - 1; i++) {
    if (!(hist[i] >= hist[i - 1] && hist[i] > hist[i + 1] && hist[i] > histThreshold)) continue;
    const d0 = binStart + i * binSize, d1 = d0 + binSize;
    let sumDepth = 0, sumWeight = 0, support = 0, strength = 0;
    for (const p of peaks) {
      if (p.depth >= d0 - 0.75 && p.depth <= d1 + 0.75) {
        sumDepth += p.depth * p.strength;
        sumWeight += p.strength;
        strength += p.strength;
        support++;
      }
    }
    if (support) clusters.push({ depth: sumDepth / Math.max(sumWeight, 1e-9), support, strength: strength / support });
  }

  const merged = [];
  for (const c of clusters.sort((a, b) => a.depth - b.depth)) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(c.depth - last.depth) < 0.7) {
      const total = last.support + c.support;
      last.depth = (last.depth * last.support + c.depth * c.support) / total;
      last.support = total;
      last.strength = Math.max(last.strength, c.strength);
    } else merged.push({ ...c });
  }

  let seeds = merged.filter(c => c.support > nt * 0.22);
  if (seeds.length < 4) seeds = merged.slice().sort((a, b) => b.support - a.support).slice(0, 6);
  seeds = seeds.sort((a, b) => a.depth - b.depth).slice(0, Number(params.maxHorizons) || 6);

  const labels = [
    "upper regolith / disturbed shallow layer",
    "layered regolith unit A",
    "layered regolith unit B",
    "strong reflector package",
    "deeper weakly resolved material",
    "deep noisy tail",
    "unclassified"
  ];
  const meanings = [
    "Upper disturbed regolith above the first continuous reflector.",
    "Layered regolith package bounded by shallow continuous reflectors.",
    "Thin layered transition with a clear dielectric contrast.",
    "Laterally persistent strong reflection package.",
    "Weakly resolved material below the tracked reflector package.",
    "Deep interval with lower continuity and higher uncertainty."
  ];

  const horizons = [];
  const halfWindow = Number(params.trackHalfWindow) || 0.85;
  for (let i = 0; i < seeds.length; i++) {
    const center = seeds[i].depth;
    const s0 = Math.max(startSample, Math.floor((center - halfWindow) / depthStep));
    const s1 = Math.min(endSample, Math.ceil((center + halfWindow) / depthStep));
    if (s1 <= s0 + 2) continue;
    const line = new Float32Array(nt);
    let strength = 0;
    for (let t = 0; t < nt; t++) {
      let bestS = s0, bestV = -Infinity;
      for (let s = s0; s <= s1; s++) {
        const v = energySmoothed[t * ns + s];
        if (v > bestV) { bestV = v; bestS = s; }
      }
      line[t] = bestS * depthStep;
      strength += bestV;
    }
    const smooth = smoothLine(line, 61);
    let minDepth = Infinity, maxDepth = -Infinity, mean = 0;
    for (const z of smooth) { minDepth = Math.min(minDepth, z); maxDepth = Math.max(maxDepth, z); mean += z; }
    mean /= smooth.length || 1;
    horizons.push({
      name: `H${i + 1}`,
      meanDepth: mean,
      medianDepth: medianTyped(smooth),
      minDepth,
      maxDepth,
      support: seeds[i].support,
      meanStrength: strength / nt,
      layerName: labels[Math.min(i, labels.length - 1)],
      meaning: meanings[Math.min(i, meanings.length - 1)],
      line: smooth
    });
  }

  const modelSamples = Number(params.modelSamples) || 480;
  const modelData = new Uint8Array(modelSamples * nt);
  const zStep = modelDepthMax / Math.max(1, modelSamples - 1);
  for (let z = 0; z < modelSamples; z++) {
    const depth = z * zStep;
    for (let t = 0; t < nt; t++) {
      let layer = 0;
      for (const h of horizons) if (depth >= h.line[t]) layer++;
      modelData[z * nt + t] = Math.min(layer, labels.length - 1);
    }
  }

  return {
    data: r,
    numTraces: nt,
    numSamples: ns,
    modelData,
    modelTraces: nt,
    modelSamples,
    modelDepthMax,
    depthStep,
    distanceStep: dx,
    velocity,
    epsilonR: (0.299792458 / velocity) ** 2,
    horizons,
    layerNames: labels,
    params: { dt, dx, velocity, loMHz, hiMHz, bgWidth, agcWindow, modelDepthMax }
  };
}
