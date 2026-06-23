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
  if (!xs.length) return 0;
  if (xs.length === 1) return ys[0] || 0;
  if (x <= xs[0]) return ys[0];
  const last = xs.length - 1;
  if (x >= xs[last]) return ys[last];
  let i = 0;
  while (i < last && xs[i + 1] < x) i++;
  const span = xs[i + 1] - xs[i] || 1;
  return ys[i] + (ys[i + 1] - ys[i]) * ((x - xs[i]) / span);
}

function lowerBound(xs, x) {
  let lo = 0, hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function cubicInterpolate(xs, ys, x, fill = 0) {
  const n = xs.length;
  if (!n) return fill;
  if (n === 1) return ys[0];
  if (n < 4 || x <= xs[0] || x >= xs[n - 1]) return linearInterpolate(xs, ys, x);
  const hi = lowerBound(xs, x);
  const start = clamp(hi - 2, 0, n - 4);
  let y = 0;
  for (let i = 0; i < 4; i++) {
    let basis = 1;
    const xi = xs[start + i];
    for (let j = 0; j < 4; j++) {
      if (i === j) continue;
      const xj = xs[start + j];
      basis *= (x - xj) / ((xi - xj) || 1e-12);
    }
    y += ys[start + i] * basis;
  }
  return Number.isFinite(y) ? y : linearInterpolate(xs, ys, x);
}

function cubicSample(line, x, fill = 0) {
  const n = line.length;
  if (!n || x < 0 || x > n - 1) return fill;
  if (n < 4 || x < 1 || x > n - 3) {
    const i = Math.floor(x), f = x - i;
    if (i < 0 || i >= n) return fill;
    return i + 1 < n ? line[i] * (1 - f) + line[i + 1] * f : line[i];
  }
  const i = Math.floor(x), f = x - i;
  const y0 = line[i - 1], y1 = line[i], y2 = line[i + 1], y3 = line[i + 2];
  const f2 = f * f, f3 = f2 * f;
  return 0.5 * ((2 * y1) + (-y0 + y2) * f + (2 * y0 - 5 * y1 + 4 * y2 - y3) * f2 + (-y0 + 3 * y1 - 3 * y2 + y3) * f3);
}

function parseTraceRanges(ranges, nt) {
  const bad = new Set();
  for (const part of String(ranges || "").split(",")) {
    const text = part.trim();
    if (!text) continue;
    const m = text.match(/^(\d+)\s*[-~]\s*(\d+)$/);
    if (m) {
      const a = Math.max(0, Math.min(nt - 1, Number(m[1])));
      const b = Math.max(0, Math.min(nt - 1, Number(m[2])));
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) bad.add(i);
    } else if (/^\d+$/.test(text)) {
      const i = Number(text);
      if (i >= 0 && i < nt) bad.add(i);
    }
  }
  return [...bad].sort((a, b) => a - b);
}

export function parseVofh(input, fallbackVelocity = 0.1) {
  if (typeof input === "number") return [[clamp(input || fallbackVelocity, 1e-6, 0.2998), 0]];
  if (Array.isArray(input)) {
    const rows = input.map(row => Array.isArray(row) ? row : [row?.velocity, row?.thickness])
      .map(row => [Number(row[0]), Number(row[1] ?? 0)])
      .filter(row => Number.isFinite(row[0]) && row[0] > 0);
    if (rows.length) return rows.map(([v, h]) => [clamp(v, 1e-6, 0.2998), Math.max(0, Number.isFinite(h) ? h : 0)]);
  }
  const text = String(input ?? "").trim();
  const rows = [];
  for (const line of text.split(/[\n;]+/)) {
    const nums = line.match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g)?.map(Number) || [];
    if (nums.length) rows.push([clamp(nums[0], 1e-6, 0.2998), Math.max(0, nums[1] ?? 0)]);
  }
  return rows.length ? rows : [[clamp(fallbackVelocity, 1e-6, 0.2998), 0]];
}

function depthAtTime(tNs, vofh) {
  let t = Math.max(0, tNs), z = 0;
  for (let i = 0; i < vofh.length; i++) {
    const [v, h] = vofh[i];
    if (h <= 0 || i === vofh.length - 1) return z + 0.5 * t * v;
    const layerTime = 2 * h / v;
    if (t <= layerTime) return z + 0.5 * t * v;
    z += h;
    t -= layerTime;
  }
  return z;
}

function timeAtDepth(zM, vofh) {
  let z = Math.max(0, zM), t = 0;
  for (let i = 0; i < vofh.length; i++) {
    const [v, h] = vofh[i];
    if (h <= 0 || i === vofh.length - 1) return t + 2 * z / v;
    if (z <= h) return t + 2 * z / v;
    t += 2 * h / v;
    z -= h;
  }
  return t;
}

export function depthAxisFromVofh(ns, dtNs = 0.625, vofhInput = "0.1,0") {
  const vofh = parseVofh(vofhInput);
  const axis = new Float32Array(ns);
  for (let s = 0; s < ns; s++) axis[s] = depthAtTime(s * dtNs, vofh);
  return axis;
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

function solveLinearSystem(matrix, rhs) {
  const n = rhs.length;
  const A = Array.from({ length: n }, (_, r) => Float64Array.from(matrix[r]));
  const b = Float64Array.from(rhs);
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[pivot][i])) pivot = r;
    if (pivot !== i) { [A[i], A[pivot]] = [A[pivot], A[i]]; [b[i], b[pivot]] = [b[pivot], b[i]]; }
    const div = Math.abs(A[i][i]) > 1e-12 ? A[i][i] : (A[i][i] < 0 ? -1e-12 : 1e-12);
    for (let c = i; c < n; c++) A[i][c] /= div;
    b[i] /= div;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = A[r][i];
      if (Math.abs(f) < 1e-18) continue;
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  return b;
}

function solveComplexLinear(ar, ai, br, bi) {
  const n = br.length;
  const A = Array.from({ length: 2 * n }, () => new Float64Array(2 * n));
  const b = new Float64Array(2 * n);
  for (let r = 0; r < n; r++) {
    b[r] = br[r]; b[r + n] = bi[r];
    for (let c = 0; c < n; c++) {
      const rr = ar[r][c], ii = ai[r][c];
      A[r][c] = rr; A[r][c + n] = -ii;
      A[r + n][c] = ii; A[r + n][c + n] = rr;
    }
  }
  const x = solveLinearSystem(A, b);
  return { re: x.slice(0, n), im: x.slice(n, 2 * n) };
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
export function removeBadTraces(d, nt, ns, ranges = "", params = {}) {
  const bad = parseTraceRanges(ranges, nt);
  const badSet = new Set(bad);
  const o = new Float32Array(d);
  if (!bad.length) return { data: o, numTraces: nt, numSamples: ns, badTraces: [] };
  const rawX = params.x || params.distanceAxisM;
  const x = new Float64Array(nt);
  for (let t = 0; t < nt; t++) x[t] = Number(rawX?.[t] ?? t);
  const good = [];
  for (let t = 0; t < nt; t++) if (!badSet.has(t)) good.push(t);
  if (!good.length) return { data: o, numTraces: nt, numSamples: ns, badTraces: bad };
  const xGood = Float64Array.from(good, t => x[t]);
  const yGood = new Float64Array(good.length);
  for (let s = 0; s < ns; s++) {
    for (let i = 0; i < good.length; i++) yGood[i] = d[good[i] * ns + s];
    for (const t of bad) o[t * ns + s] = cubicInterpolate(xGood, yGood, x[t], yGood[0] || 0);
  }
  return { data: o, numTraces: nt, numSamples: ns, badTraces: bad };
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

function fftShift1(re, im) {
  const n = re.length, h = Math.floor(n / 2);
  const rr = new Float64Array(n), ii = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + h) % n;
    rr[j] = re[i]; ii[j] = im[i];
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

function migrationParams(params, velocity = 0.1, dt = 0.625, dx = 0.05) {
  if (typeof params === "object") {
    return {
      dtNs: safeNumber(params.dtNs ?? params.dt, dt),
      dxM: safeNumber(params.dxM ?? params.dx, dx),
      vofh: parseVofh(params.vofh ?? params.velocity, safeNumber(params.velocity, velocity)),
      dzM: safeNumber(params.dzM ?? params.dz, NaN),
      zMaxM: safeNumber(params.zMaxM ?? params.zMax, NaN),
      fMaxGHz: safeNumber(params.fMaxGHz, NaN),
      q: safeNumber(params.q, NaN),
      antennaFreqMHz: safeNumber(params.antennaFreqMHz, NaN)
    };
  }
  return { dtNs: dt, dxM: dx, vofh: parseVofh(velocity), dzM: NaN, zMaxM: NaN, fMaxGHz: NaN, q: NaN, antennaFreqMHz: NaN };
}

function velocityProfile(ns, dtNs, vofh) {
  const zt = new Float64Array(ns);
  const vrms = new Float64Array(ns);
  zt[0] = 0;
  vrms[0] = vofh[0][0];
  let cum = 0;
  for (let s = 0; s < ns; s++) zt[s] = depthAtTime(s * dtNs, vofh);
  for (let s = 1; s < ns; s++) {
    const vint = Math.max(1e-6, 2 * (zt[s] - zt[s - 1]) / dtNs);
    cum += dtNs * vint * vint;
    vrms[s] = Math.sqrt(cum / Math.max(dtNs, s * dtNs));
  }
  return { zt, vrms };
}

function velocityAtDepth(zM, vofh) {
  let z = Math.max(0, zM);
  for (let i = 0; i < vofh.length; i++) {
    const [v, h] = vofh[i];
    if (h <= 0 || i === vofh.length - 1 || z <= h) return v;
    z -= h;
  }
  return vofh[vofh.length - 1][0];
}

function complexInterpColumn(re, im, rows, cols, col, pos) {
  if (pos < 0 || pos > rows - 1) return [0, 0];
  const r0 = Math.floor(pos), f = pos - r0;
  const i0 = r0 * cols + col;
  if (r0 >= rows - 1) return [re[i0], im[i0]];
  const i1 = i0 + cols;
  return [re[i0] * (1 - f) + re[i1] * f, im[i0] * (1 - f) + im[i1] * f];
}

function stoltUniform(d, nt, ns, dtNs, dxM, velocity) {
  const rows = nextPow2(2 * ns), cols = nextPow2(nt);
  const re = new Float64Array(rows * cols), im = new Float64Array(rows * cols);
  for (let t = 0; t < nt; t++) for (let s = 0; s < ns; s++) re[s * cols + t] = d[t * ns + s];
  fft2D(re, im, rows, cols);
  fftShift2(re, im, rows, cols);
  const imgR = new Float64Array(rows * cols), imgI = new Float64Array(rows * cols);
  const dz = Math.max(1e-9, velocity * dtNs / 2);
  const w0 = -Math.PI / dtNs, dw = 2 * Math.PI / (rows * dtNs);
  const kx0 = -Math.PI / Math.max(dxM, 1e-9), dkx = 2 * Math.PI / (cols * Math.max(dxM, 1e-9));
  const kz0 = -Math.PI / dz, dkz = 2 * Math.PI / (rows * dz);
  for (let c = 0; c < cols; c++) {
    const kx = kx0 + c * dkx;
    for (let r = 0; r < rows; r++) {
      const kz = kz0 + r * dkz;
      const ks = Math.hypot(kx, kz);
      if (ks < 1e-12) continue;
      const wz = Math.sign(kz || 1) * ks * velocity / 2;
      const pos = (wz - w0) / dw;
      const [fr, fi] = complexInterpColumn(re, im, rows, cols, c, pos);
      const scale = velocity * Math.abs(kz) / ks;
      imgR[r * cols + c] = fr * scale;
      imgI[r * cols + c] = fi * scale;
    }
  }
  fftShift2(imgR, imgI, rows, cols);
  fft2D(imgR, imgI, rows, cols, true);
  const out = new Float32Array(nt * ns);
  for (let t = 0; t < nt; t++) for (let s = 0; s < ns; s++) out[t * ns + s] = imgR[s * cols + t];
  return out;
}

export function stoltMigration(d, nt, ns, params = {}) {
  const { dtNs, dxM, vofh } = migrationParams(params);
  if (vofh.length === 1 || vofh.every(([, h], i) => i === vofh.length - 1 || h === 0)) {
    return { data: stoltUniform(d, nt, ns, dtNs, dxM, vofh[0][0]), numTraces: nt, numSamples: ns, vofh };
  }
  const { vrms } = velocityProfile(ns, dtNs, vofh);
  let vmig = Infinity;
  for (let s = 1; s < ns; s++) if (vrms[s] > 0) vmig = Math.min(vmig, vrms[s]);
  if (!Number.isFinite(vmig)) vmig = vofh[0][0];
  const st = new Float64Array(ns);
  const scale = 2 / (vmig * vmig);
  let cum = 0;
  for (let s = 1; s < ns; s++) {
    const t0 = (s - 1) * dtNs, t1 = s * dtNs;
    cum += 0.5 * dtNs * (t0 * vrms[s - 1] * vrms[s - 1] + t1 * vrms[s] * vrms[s]);
    st[s] = Math.sqrt(Math.max(0, scale * cum));
  }
  let delt = Infinity;
  for (let s = 1; s < ns; s++) if (st[s] > st[s - 1]) delt = Math.min(delt, st[s] - st[s - 1]);
  if (!Number.isFinite(delt) || delt <= 0) delt = dtNs;
  const nss = Math.max(ns, Math.ceil(st[ns - 1] / delt) + 1);
  const tt = Float64Array.from({ length: ns }, (_, s) => s * dtNs);
  const ds = new Float32Array(nt * nss);
  for (let t = 0; t < nt; t++) {
    const line = d.subarray(t * ns, t * ns + ns);
    for (let s = 0; s < nss; s++) {
      const sourceT = cubicInterpolate(st, tt, s * delt, 0);
      ds[t * nss + s] = cubicSample(line, sourceT / dtNs, 0);
    }
  }
  const migrated = stoltUniform(ds, nt, nss, delt, dxM, vmig);
  const out = new Float32Array(nt * ns);
  for (let t = 0; t < nt; t++) {
    const line = migrated.subarray(t * nss, t * nss + nss);
    for (let s = 0; s < ns; s++) out[t * ns + s] = cubicSample(line, st[s] / delt, 0);
  }
  return { data: out, numTraces: nt, numSamples: ns, vofh, migrationVelocity: vmig };
}

function gazdagImage(d, nt, ns, dtNs, dxM, vofh) {
  const rows = nextPow2(ns), cols = nextPow2(nt);
  const fkR = new Float64Array(rows * cols), fkI = new Float64Array(rows * cols);
  for (let t = 0; t < nt; t++) for (let s = 0; s < ns; s++) fkR[s * cols + t] = d[t * ns + s];
  fft2D(fkR, fkI, rows, cols);
  fftShift2(fkR, fkI, rows, cols);
  const imgR = new Float64Array(ns * cols), imgI = new Float64Array(ns * cols);
  const w0 = -Math.PI / dtNs, dw = 2 * Math.PI / (rows * dtNs);
  const kx0 = -Math.PI / Math.max(dxM, 1e-9), dkx = 2 * Math.PI / (cols * Math.max(dxM, 1e-9));
  const vByTime = new Float64Array(ns);
  if (vofh.length === 1) vByTime.fill(vofh[0][0]);
  else {
    const { zt } = velocityProfile(ns, dtNs, vofh);
    for (let s = 0; s < ns - 1; s++) vByTime[s] = Math.max(1e-6, 2 * (zt[s + 1] - zt[s]) / dtNs);
    vByTime[ns - 1] = vByTime[ns - 2] || vofh[0][0];
  }
  const tMax = Math.max(dtNs, (ns - 1) * dtNs);
  for (let c = 0; c < cols; c++) {
    const kx = kx0 + c * dkx;
    const workR = new Float64Array(rows), workI = new Float64Array(rows);
    for (let r = 0; r < rows; r++) { workR[r] = fkR[r * cols + c]; workI[r] = fkI[r * cols + c]; }
    for (let s = 0; s < ns; s++) {
      const v = vByTime[s];
      const tau = s * dtNs;
      let sumR = 0, sumI = 0;
      for (let r = 0; r < rows; r++) {
        let w = w0 + r * dw;
        if (Math.abs(w) < 1e-12) w = 1e-12 / dtNs;
        const coss = 1 - ((0.5 * v * kx) / w) ** 2;
        if (coss > (vofh.length === 1 ? 0 : (tau / tMax) ** 2)) {
          const phase = -w * dtNs * Math.sqrt(Math.max(0, coss));
          const cr = Math.cos(phase), ci = -Math.sin(phase);
          const nr = workR[r] * cr - workI[r] * ci;
          const ni = workR[r] * ci + workI[r] * cr;
          workR[r] = nr; workI[r] = ni;
          sumR += nr; sumI += ni;
        } else {
          workR[r] = 0; workI[r] = 0;
        }
      }
      imgR[s * cols + c] = sumR / rows;
      imgI[s * cols + c] = sumI / rows;
    }
  }
  const out = new Float32Array(nt * ns);
  for (let s = 0; s < ns; s++) {
    const lr = new Float64Array(cols), li = new Float64Array(cols);
    for (let c = 0; c < cols; c++) { lr[c] = imgR[s * cols + c]; li[c] = imgI[s * cols + c]; }
    fftShift1(lr, li);
    fft(lr, li, true);
    for (let t = 0; t < nt; t++) out[t * ns + s] = lr[t];
  }
  return out;
}

export function gazdagMigration(d, nt, ns, params = {}) {
  const { dtNs, dxM, vofh } = migrationParams(params);
  return { data: gazdagImage(d, nt, ns, dtNs, dxM, vofh), numTraces: nt, numSamples: ns, vofh };
}

function toFkPositive(d, nt, ns, dtNs) {
  const ntpad = nextPow2(2 * ns), cols = nextPow2(nt);
  const nf = Math.floor(ntpad / 2) + 1;
  const fkR = new Float64Array(nf * cols), fkI = new Float64Array(nf * cols);
  for (let t = 0; t < nt; t++) {
    const tr = new Float64Array(ntpad), ti = new Float64Array(ntpad);
    tr.set(d.subarray(t * ns, t * ns + ns));
    fft(tr, ti);
    for (let k = 0; k < nf; k++) { fkR[k * cols + t] = tr[k]; fkI[k * cols + t] = ti[k]; }
  }
  for (let k = 0; k < nf; k++) {
    const lr = fkR.slice(k * cols, k * cols + cols), li = fkI.slice(k * cols, k * cols + cols);
    fft(lr, li, true);
    fkR.set(lr, k * cols); fkI.set(li, k * cols);
  }
  const f = Float64Array.from({ length: nf }, (_, k) => k / (ntpad * dtNs));
  return { fkR, fkI, f, cols };
}

export function splitStepMigration(d, nt, ns, params = {}) {
  const mp = migrationParams(params);
  const dzM = Number.isFinite(mp.dzM) && mp.dzM > 0 ? mp.dzM : 0.02;
  const zMax = Number.isFinite(mp.zMaxM) && mp.zMaxM > 0 ? mp.zMaxM : depthAtTime((ns - 1) * mp.dtNs, mp.vofh);
  const zAxis = new Float32Array(Math.max(2, Math.floor(zMax / dzM) + 1));
  for (let z = 0; z < zAxis.length; z++) zAxis[z] = z * dzM;
  const { fkR, fkI, f, cols } = toFkPositive(d, nt, ns, mp.dtNs);
  const fNyq = 1 / (2 * mp.dtNs);
  const fMax = Number.isFinite(mp.fMaxGHz) && mp.fMaxGHz > 0 ? Math.min(mp.fMaxGHz, fNyq) : 0.6 * fNyq;
  let nfmax = 1;
  while (nfmax < f.length && f[nfmax] <= fMax) nfmax++;
  const kxNyq = 1 / (2 * Math.max(mp.dxM, 1e-9)), dkx = 2 * kxNyq / cols;
  const kx = Float64Array.from({ length: cols }, (_, i) => i <= cols / 2 ? i * dkx : (i - cols) * dkx);
  const out = new Float32Array(nt * zAxis.length);
  const useDispersion = Number.isFinite(mp.q) && mp.q > 0 && Number.isFinite(mp.antennaFreqMHz) && mp.antennaFreqMHz > 0;
  const expq = useDispersion ? 0.5 * (1 - (2 / Math.PI) * Math.atan(mp.q)) : 0;
  const wc = useDispersion ? 2 * Math.PI * mp.antennaFreqMHz * 1e6 : 1;
  for (let iz = 0; iz < zAxis.length; iz++) {
    const baseV = 0.5 * velocityAtDepth(zAxis[iz], mp.vofh);
    for (let c = 0; c < cols; c++) {
      const k2 = kx[c] * kx[c];
      for (let jf = 1; jf < nfmax; jf++) {
        const freq = f[jf];
        const disperse = useDispersion ? ((2 * Math.PI * freq * 1e9) / wc) ** expq : 1;
        const v = Math.max(1e-6, baseV * disperse);
        const coss = 1 - (v * v * k2) / Math.max(freq * freq, 1e-18);
        const idx = jf * cols + c;
        if (coss <= 0) { fkR[idx] = 0; fkI[idx] = 0; continue; }
        const phase = (2 * Math.PI * freq / v) * (Math.sqrt(coss) - 1) * dzM;
        const cr = Math.cos(phase), ci = Math.sin(phase);
        const nr = fkR[idx] * cr - fkI[idx] * ci;
        const ni = fkR[idx] * ci + fkI[idx] * cr;
        fkR[idx] = nr; fkI[idx] = ni;
      }
    }
    for (let jf = 1; jf < nfmax; jf++) {
      const lr = fkR.slice(jf * cols, jf * cols + cols), li = fkI.slice(jf * cols, jf * cols + cols);
      fft(lr, li);
      const freq = f[jf];
      const disperse = useDispersion ? ((2 * Math.PI * freq * 1e9) / wc) ** expq : 1;
      const v = Math.max(1e-6, baseV * disperse);
      const phase = 2 * Math.PI * freq * dzM / v;
      const cr = Math.cos(phase), ci = Math.sin(phase);
      for (let t = 0; t < nt; t++) {
        const nr = lr[t] * cr - li[t] * ci;
        const ni = lr[t] * ci + li[t] * cr;
        lr[t] = nr; li[t] = ni;
        out[t * zAxis.length + iz] += 2 * nr;
      }
      fft(lr, li, true);
      fkR.set(lr, jf * cols); fkI.set(li, jf * cols);
    }
  }
  const norm = 1 / Math.max(1, 2 * nfmax);
  for (let i = 0; i < out.length; i++) out[i] *= norm;
  return { data: out, numTraces: nt, numSamples: zAxis.length, depthAxisM: zAxis, depthStep: dzM, verticalAxisKind: "depth", vofh: mp.vofh };
}

export function splitStepForward2d(model = {}, params = {}) {
  const nx = Math.max(1, Math.floor(Number(model.nx || model.numTraces || 0)));
  const nz = Math.max(1, Math.floor(Number(model.nz || model.numSamples || 0)));
  if (!nx || !nz) throw new Error("Split-step forward requires a valid 2-D model.");
  const total = nx * nz;
  const eps = modelField(model, ["epsrField", "ep", "data"], total, 1);
  const mu = modelField(model, ["muField", "mu"], total, 1);
  const sig = modelField(model, ["sigmaField", "sig", "cd"], total, 0);
  const dxM = positiveNumber(params.dxM ?? params.distanceStepM ?? model.distanceStepM, inferAxisStep(model.distanceAxisM, 0.02));
  const dzM = positiveNumber(params.dzM ?? params.depthStepM ?? model.depthStepM, inferAxisStep(model.depthAxisM, dxM));
  const nt = Math.max(16, Math.floor(Number(params.nt || params.samples || params.numSamples || 512)));
  const dtS = positiveNumber(params.dtS, positiveNumber(params.dtNs, 0.625) * 1e-9);
  const frequencyHz = positiveNumber(params.frequencyHz, positiveNumber(params.frequencyMHz, 500) * 1e6);
  const band = Number.isFinite(Number(params.band)) ? Number(params.band) : 1;
  const nt2 = nextPow2(nt);
  const nxfft = nextPow2(nx);
  const half = Math.floor(nt2 / 2);
  const kStart = band === 0
    ? clamp(Math.floor(nt2 * dtS * frequencyHz * 0.25), 1, half)
    : 1;
  const kEnd = band === 0
    ? clamp(Math.floor(nt2 * dtS * frequencyHz * 2), kStart, half)
    : half;
  const omega = new Float64Array(half + 1);
  const bomega2 = new Float64Array(half + 1);
  const taper = new Float64Array(half + 1);
  taper.fill(1);
  for (let iw = kStart; iw <= kEnd; iw++) omega[iw] = iw * 2 * Math.PI / (nt2 * dtS);
  if (band > 0) {
    const iwc = Math.max(1, Math.floor(nt2 * dtS * frequencyHz));
    const sigmaBins = Math.max(1, (kEnd - kStart + 1) * band);
    for (let iw = kStart; iw <= kEnd; iw++) taper[iw] = Math.exp(-(((iw - iwc) / sigmaBins) ** 2));
  }

  const q = buildQualityField(model, eps, sig, total, frequencyHz);
  const vit = new Float64Array(total);
  const vitm = new Float64Array(nz);
  const qm = new Float64Array(nz);
  const m0 = 4 * Math.PI * 1e-7;
  const e0 = 8.8592e-12;
  for (let iz = 0; iz < nz; iz++) {
    let vSum = 0;
    let qSum = 0;
    for (let ix = 0; ix < nx; ix++) {
      const idx = iz * nx + ix;
      const epsr = Math.max(1e-9, Number(eps[idx]) || 1);
      const mur = Math.max(1e-9, Number(mu[idx]) || 1);
      const qq = clamp(Number(q[idx]) || 1e6, 1, 1e6);
      const cosTerm = Math.max(1e-9, Math.abs(Math.cos((Math.PI / 4) * (1 - (2 / Math.PI) * Math.atan(qq)))));
      const velocity = 1 / (Math.sqrt(m0 * mur * e0 * epsr) * cosTerm);
      vit[idx] = Number.isFinite(velocity) && velocity > 0 ? velocity : 299792458 / Math.sqrt(epsr);
      vSum += vit[idx] / 2;
      qSum += qq;
    }
    vitm[iz] = Math.max(1e-9, vSum / nx);
    qm[iz] = Math.max(1, qSum / nx);
  }
  for (let iw = kStart; iw <= kEnd; iw++) bomega2[iw] = (omega[iw] / vitm[0]) ** 2;

  const zpR = new Float64Array(nz * nxfft);
  const zpI = new Float64Array(nz * nxfft);
  for (let iz = 1; iz < nz; iz++) {
    const row = iz * nxfft;
    const prev = (iz - 1) * nx;
    const curr = iz * nx;
    for (let ix = 0; ix < nx; ix++) {
      const c1 = matgprReflectorRoot(eps[curr + ix], mu[curr + ix], q[curr + ix]);
      const c0 = matgprReflectorRoot(eps[prev + ix], mu[prev + ix], q[prev + ix]);
      const den = cdiv(1, 0, c1.r + c0.r, c1.i + c0.i);
      const rr = c1.r - c0.r;
      const ri = c1.i - c0.i;
      zpR[row + ix] = rr * den.r - ri * den.i;
      zpI[row + ix] = rr * den.i + ri * den.r;
    }
  }
  for (let iz = 0; iz < nz; iz++) fft(zpR.subarray(iz * nxfft, iz * nxfft + nxfft), zpI.subarray(iz * nxfft, iz * nxfft + nxfft));

  const cpR = new Float64Array(nt2 * nxfft);
  const cpI = new Float64Array(nt2 * nxfft);
  const waven = new Float64Array(nxfft);
  const waven2 = new Float64Array(nxfft);
  for (let ik = 0; ik < nxfft; ik++) {
    const folded = ik <= nxfft / 2 ? ik : nxfft - ik;
    const kx = folded * 2 * Math.PI / (nxfft * dxM);
    waven[ik] = kx;
    waven2[ik] = kx * kx;
  }

  const meanKR = new Float64Array(half + 1);
  const meanKI = new Float64Array(half + 1);
  const dencR = new Float64Array(half + 1);
  const dencI = new Float64Array(half + 1);
  const alf1 = Math.PI * 60 / 180;
  const alf2 = Math.PI * 80 / 180;
  const wr = 2 * Math.PI * frequencyHz;
  for (let iz = nz - 1; iz >= 0; iz--) {
    const nq = (2 / Math.PI) * Math.atan(qm[iz]);
    const expq = (1 - nq) / 2;
    const tanq = Math.tan((1 - nq) * Math.PI / 4);
    for (let iw = kStart; iw <= kEnd; iw++) {
      const ratio = Math.max(1e-12, (omega[iw] / wr) ** expq);
      const br = omega[iw] / (vitm[iz] * ratio);
      const bi = br * tanq;
      meanKR[iw] = br;
      meanKI[iw] = bi;
      dencR[iw] = br * br - bi * bi;
      dencI[iw] = 2 * br * bi;
    }
    const zrow = iz * nxfft;
    for (let ik = 0; ik < nxfft; ik++) {
      const den = waven2[ik];
      for (let iw = kStart; iw <= kEnd; iw++) {
        const kz = csqrt(dencR[iw] - den, dencI[iw]);
        const amp = Math.exp(Math.max(-60, Math.min(60, -Math.abs(dzM * kz.i))));
        const phase = dzM * kz.r;
        let sr = Math.cos(phase) * amp;
        let si = Math.sin(phase) * amp;
        const dif = bomega2[iw] - den;
        let radiation = 1;
        if (dif > 0) {
          const tet = Math.atan(waven[ik] / Math.max(1e-30, Math.sqrt(dif)));
          if (tet > alf2) radiation = 0;
          else if (tet > alf1) {
            const a = 1 + (tet - alf1) / (alf2 - alf1);
            radiation = 0.42 - 0.5 * Math.cos(a * Math.PI) + 0.08 * Math.cos(a * 2 * Math.PI);
          }
        }
        const idx = iw * nxfft + ik;
        const cr = cpR[idx] * sr - cpI[idx] * si;
        const ci = cpR[idx] * si + cpI[idx] * sr;
        cpR[idx] = (cr * taper[iw] + zpR[zrow + ik]) * radiation;
        cpI[idx] = (ci * taper[iw] + zpI[zrow + ik]) * radiation;
      }
    }
    for (let iw = kStart; iw <= kEnd; iw++) fft(cpR.subarray(iw * nxfft, iw * nxfft + nxfft), cpI.subarray(iw * nxfft, iw * nxfft + nxfft), true);
    for (let ix = 0; ix < nx; ix++) {
      const midx = iz * nx + ix;
      const localQ = Math.max(1, q[midx]);
      const localNq = (2 / Math.PI) * Math.atan(localQ);
      const localExpq = (1 - localNq) / 2;
      const localTan = Math.tan((1 - localNq) * Math.PI / 4);
      for (let iw = kStart; iw <= kEnd; iw++) {
        const ratio = Math.max(1e-12, (omega[iw] / wr) ** localExpq);
        const lr = omega[iw] / ((vit[midx] * ratio) / 2);
        const li = lr * localTan;
        const realPhase = (meanKI[iw] - li) * dzM;
        const imagPhase = -(meanKR[iw] - lr) * dzM;
        const amp = Math.exp(Math.max(-60, Math.min(60, realPhase)));
        const sr = Math.cos(imagPhase) * amp;
        const si = Math.sin(imagPhase) * amp;
        const idx = iw * nxfft + ix;
        const cr = cpR[idx] * sr - cpI[idx] * si;
        cpI[idx] = cpR[idx] * si + cpI[idx] * sr;
        cpR[idx] = cr;
      }
    }
    for (let ix = nx; ix < nxfft; ix++) {
      for (let iw = kStart; iw <= kEnd; iw++) {
        const idx = iw * nxfft + ix;
        cpR[idx] = 0;
        cpI[idx] = 0;
      }
    }
    for (let iw = kStart; iw <= kEnd; iw++) fft(cpR.subarray(iw * nxfft, iw * nxfft + nxfft), cpI.subarray(iw * nxfft, iw * nxfft + nxfft));
    params.onProgress?.({ progress: (nz - iz) / nz, depthIndex: iz, depthCount: nz });
  }
  for (let iw = kStart; iw <= kEnd; iw++) fft(cpR.subarray(iw * nxfft, iw * nxfft + nxfft), cpI.subarray(iw * nxfft, iw * nxfft + nxfft), true);
  for (let iw = kStart; iw <= kEnd; iw++) {
    const mirror = nt2 - iw;
    if (mirror <= 0 || mirror >= nt2 || mirror === iw) continue;
    for (let ix = 0; ix < nxfft; ix++) {
      cpR[mirror * nxfft + ix] = cpR[iw * nxfft + ix];
      cpI[mirror * nxfft + ix] = -cpI[iw * nxfft + ix];
    }
  }

  const xAxis = axisFromModel(model.distanceAxisM, nx, dxM);
  const traceCount = Math.max(1, Math.floor(Number(params.traceCount || params.numTraces || nx)));
  const startX = Number.isFinite(Number(params.startX)) ? Number(params.startX) : xAxis[0];
  const endX = Number.isFinite(Number(params.endX)) ? Number(params.endX) : xAxis[xAxis.length - 1];
  const srcx = new Float32Array(traceCount);
  const data = new Float32Array(traceCount * nt);
  const timeAxisNs = new Float32Array(nt);
  const tout = new Float64Array(nt);
  for (let is = 0; is < nt; is++) {
    tout[is] = is * dtS;
    timeAxisNs[is] = is * dtS * 1e9;
  }
  const trR = new Float64Array(nt2);
  const trI = new Float64Array(nt2);
  for (let it = 0; it < traceCount; it++) {
    const targetX = traceCount === 1 ? (startX + endX) / 2 : startX + (endX - startX) * it / (traceCount - 1);
    let ix = Math.round((targetX - xAxis[0]) / Math.max(1e-12, dxM));
    ix = clamp(ix, 0, nx - 1);
    srcx[it] = xAxis[ix];
    trR.fill(0);
    trI.fill(0);
    for (let iw = 0; iw < nt2; iw++) {
      const idx = iw * nxfft + ix;
      trR[iw] = cpR[idx];
      trI[iw] = cpI[idx];
    }
    fft(trR, trI);
    for (let is = 0; is < nt; is++) data[it * nt + is] = Number.isFinite(trR[is]) ? trR[is] : 0;
  }
  return {
    data,
    numTraces: traceCount,
    numSamples: nt,
    tout,
    srcx,
    recx: srcx,
    x: srcx,
    dtNs: dtS * 1e9,
    dxM: traceCount > 1 ? Math.abs(srcx[1] - srcx[0]) : dxM,
    name: "split_step_forward2d",
    backend: "js-worker-split-step",
    meta: {
      verticalAxisKind: "time",
      timeAxisNs,
      distanceAxisM: srcx,
      x: srcx,
      radarParams: {
        dtNs: dtS * 1e9,
        dxM: traceCount > 1 ? Math.abs(srcx[1] - srcx[0]) : dxM,
        antennaFreqMHz: frequencyHz / 1e6
      }
    }
  };
}

function modelField(model, keys, length, fallback) {
  for (const key of keys) {
    const value = model?.[key];
    if (value?.length === length) return value;
  }
  const out = new Float32Array(length);
  out.fill(fallback);
  return out;
}

function buildQualityField(model, eps, sig, length, frequencyHz) {
  const source = model.qField || model.q || model.Q;
  if (source?.length === length) return Float32Array.from(source, v => clamp(Number(v) || 1e6, 1, 1e6));
  const out = new Float32Array(length);
  const e0 = 8.8592e-12;
  for (let i = 0; i < length; i++) {
    const sigma = Math.max(0, Number(sig[i]) || 0);
    const epsr = Math.max(1e-9, Number(eps[i]) || 1);
    out[i] = sigma <= 1e-18 ? 1e6 : clamp(2 * Math.PI * frequencyHz * e0 * epsr / sigma, 1, 1e6);
  }
  return out;
}

function matgprReflectorRoot(epsrInput, muInput, qInput) {
  const epsr = Math.max(1e-9, Number(epsrInput) || 1);
  const mur = Math.max(1e-9, Number(muInput) || 1);
  const q = clamp(Number(qInput) || 1e6, 1, 1e6);
  const angle = Math.atan(q);
  const denR = epsr * Math.sin(angle);
  const denI = Math.cos(epsr * angle);
  const ratio = cdiv(mur, 0, denR, denI);
  return csqrt(ratio.r, ratio.i);
}

function cdiv(ar, ai, br, bi) {
  const den = br * br + bi * bi || 1e-30;
  return { r: (ar * br + ai * bi) / den, i: (ai * br - ar * bi) / den };
}

function csqrt(ar, ai) {
  const mag = Math.hypot(ar, ai);
  const r = Math.sqrt(Math.max(0, (mag + ar) / 2));
  const i = (ai < 0 ? -1 : 1) * Math.sqrt(Math.max(0, (mag - ar) / 2));
  return { r: Number.isFinite(r) ? r : 0, i: Number.isFinite(i) ? i : 0 };
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function inferAxisStep(axis, fallback) {
  if (axis?.length > 1) {
    const step = Math.abs(Number(axis[1]) - Number(axis[0]));
    if (Number.isFinite(step) && step > 0) return step;
  }
  return fallback;
}

function axisFromModel(axis, count, step) {
  if (axis?.length === count) return Float32Array.from(axis);
  return Float32Array.from({ length: count }, (_, i) => i * step);
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

export function pspiMigration(d, nt, ns, params = {}) {
  const dtNs = safeNumber(params.dtNs ?? params.dt, 0.625);
  const dxM = safeNumber(params.dxM ?? params.dx, 0.05);
  const velocity = safeNumber(params.velocity, 0.1);
  const dzM = Number.isFinite(params.dzM) && params.dzM > 0 ? params.dzM : 0.02;
  const zMax = Number.isFinite(params.zMaxM) && params.zMaxM > 0
    ? params.zMaxM
    : velocity * dtNs * (ns - 1) / 2;

  const nz = Math.max(2, Math.floor(zMax / dzM) + 1);
  const zmig = new Float32Array(nz);
  for (let iz = 0; iz < nz; iz++) zmig[iz] = iz * dzM;

  const ntfft = ns;
  const nw = Math.floor(ntfft / 2) + 1;
  const dw = 2 * Math.PI / (ntfft * dtNs * 1e-9);
  const nxfft = nextPow2(nt);
  const dk = 2 * Math.PI / (nxfft * dxM);

  const w = new Float64Array(nw);
  w[0] = 1e-10 / (dtNs * 1e-9);
  for (let iw = 1; iw < nw; iw++) w[iw] = iw * dw;

  const cdR = new Float64Array(nw * nxfft);
  const cdI = new Float64Array(nw * nxfft);

  for (let ix = 0; ix < nt; ix++) {
    const tr = new Float64Array(ntfft), ti = new Float64Array(ntfft);
    for (let s = 0; s < ns; s++) tr[s] = d[ix * ns + s];
    fft(tr, ti);
    for (let iw = 0; iw < nw; iw++) {
      cdR[iw * nxfft + ix] = tr[iw];
      cdI[iw * nxfft + ix] = ti[iw];
    }
  }

  const dmig = new Float32Array(nz * nt);
  const vhalf = velocity * 0.5;
  const kxNyq = Math.PI / dxM;

  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nt; ix++) {
      let sum = 0;
      for (let iw = 0; iw < nw; iw++) sum += cdR[iw * nxfft + ix];
      dmig[iz * nt + ix] += sum;
    }

    for (let ix = 0; ix < nt; ix++) {
      for (let iw = 0; iw < nw; iw++) {
        const phase = -w[iw] * dzM * 2 / velocity;
        const cr = Math.cos(phase), ci = Math.sin(phase);
        const idx = iw * nxfft + ix;
        const nr = cdR[idx] * cr - cdI[idx] * ci;
        const ni = cdR[idx] * ci + cdI[idx] * cr;
        cdR[idx] = nr;
        cdI[idx] = ni;
      }
    }

    for (let iw = 0; iw < nw; iw++) {
      const off = iw * nxfft;
      const lr = cdR.subarray(off, off + nxfft);
      const li = cdI.subarray(off, off + nxfft);
      fft(lr, li);
      fftShift1(lr, li);
    }

    for (let iw = 0; iw < nw; iw++) {
      const freq = w[iw];
      for (let ik = 0; ik < nxfft; ik++) {
        const kx = ik < nxfft / 2 ? ik * dk : (ik - nxfft) * dk;
        const ratio = (vhalf * kx) / freq;
        const kz = 1 - ratio * ratio;

        const idx = iw * nxfft + ik;
        if (kz > 0) {
          const phase = -freq * Math.sqrt(kz) * dzM / vhalf + freq * dzM / vhalf;
          const cr = Math.cos(phase), ci = Math.sin(phase);
          const nr = cdR[idx] * cr - cdI[idx] * ci;
          const ni = cdR[idx] * ci + cdI[idx] * cr;
          cdR[idx] = nr;
          cdI[idx] = ni;
        } else {
          const decay = Math.exp(-freq * Math.sqrt(-kz) * dzM / vhalf);
          cdR[idx] *= decay;
          cdI[idx] *= decay;
        }
      }
    }

    for (let iw = 0; iw < nw; iw++) {
      const off = iw * nxfft;
      const lr = cdR.subarray(off, off + nxfft);
      const li = cdI.subarray(off, off + nxfft);
      fftShift1(lr, li);
      fft(lr, li, true);
    }
  }

  const norm = 1 / ntfft;
  for (let i = 0; i < dmig.length; i++) dmig[i] *= norm;

  return {
    data: dmig,
    numTraces: nt,
    numSamples: nz,
    depthAxisM: zmig,
    depthStep: dzM,
    verticalAxisKind: "depth",
    velocity
  };
}

export function timeDepth(d, nt, ns, velocityOrParams = 0.1, dt = 0.625, dz = 0.02) {
  const params = typeof velocityOrParams === "object" ? velocityOrParams : { velocity: velocityOrParams, dt, dz };
  const dtNs = safeNumber(params.dtNs ?? params.dt, dt);
  const vofh = parseVofh(params.vofh ?? params.velocity, safeNumber(params.velocity, 0.1));
  const maxDepth = depthAtTime((ns - 1) * dtNs, vofh);
  const dzM = safeNumber(params.dzM ?? params.dz, dz || vofh[0][0] * dtNs / 2);
  const newNs = Math.max(2, Math.ceil(maxDepth / Math.max(dzM, 1e-9)));
  const depthAxisM = new Float32Array(newNs);
  const o = new Float32Array(nt * newNs);
  for (let z = 0; z < newNs; z++) depthAxisM[z] = z * dzM;
  for (let t = 0; t < nt; t++) {
    const line = d.subarray(t * ns, t * ns + ns);
    for (let z = 0; z < newNs; z++) {
      const sample = timeAtDepth(depthAxisM[z], vofh) / dtNs;
      o[t * newNs + z] = cubicSample(line, sample, 0);
    }
  }
  return { data: o, numTraces: nt, numSamples: newNs, depthStep: dzM, depthAxisM, verticalAxisKind: "depth", vofh };
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function norm(a) {
  return Math.sqrt(dot(a, a));
}

function orthogonalize(v, basis) {
  for (const b of basis) {
    const c = dot(v, b);
    for (let i = 0; i < v.length; i++) v[i] -= c * b[i];
  }
  const n = norm(v);
  if (n > 1e-12) for (let i = 0; i < v.length; i++) v[i] /= n;
  return n;
}

export function karhunenLoeveFilter(d, nt, ns, params = {}) {
  const p = clamp(Math.floor(safeNumber(params.components ?? params.width, 9)), 1, Math.min(nt, ns));
  const output = String(params.output || "model").toLowerCase();
  const us = [], vs = [], sigmas = [];
  const multiplyV = v => {
    const u = new Float64Array(ns);
    for (let t = 0; t < nt; t++) {
      const vt = v[t];
      for (let s = 0; s < ns; s++) u[s] += d[t * ns + s] * vt;
    }
    return u;
  };
  const multiplyTU = u => {
    const v = new Float64Array(nt);
    for (let t = 0; t < nt; t++) {
      let sum = 0;
      for (let s = 0; s < ns; s++) sum += d[t * ns + s] * u[s];
      v[t] = sum;
    }
    return v;
  };
  for (let c = 0; c < p; c++) {
    let v = Float64Array.from({ length: nt }, (_, i) => Math.sin((i + 1) * (c + 1) * 1.61803398875) + 0.25 * Math.cos((i + 3) * (c + 2)));
    orthogonalize(v, vs);
    for (let iter = 0; iter < 32; iter++) {
      let u = multiplyV(v);
      for (let j = 0; j < us.length; j++) for (let s = 0; s < ns; s++) u[s] -= sigmas[j] * us[j][s] * dot(v, vs[j]);
      const su = norm(u);
      if (su <= 1e-12) break;
      for (let s = 0; s < ns; s++) u[s] /= su;
      v = multiplyTU(u);
      orthogonalize(v, vs);
    }
    const u = multiplyV(v);
    const sigma = norm(u);
    if (sigma <= 1e-10) break;
    for (let s = 0; s < ns; s++) u[s] /= sigma;
    us.push(u); vs.push(v); sigmas.push(sigma);
  }
  const model = new Float32Array(nt * ns);
  for (let c = 0; c < sigmas.length; c++) {
    const u = us[c], v = vs[c], sigma = sigmas[c];
    for (let t = 0; t < nt; t++) for (let s = 0; s < ns; s++) model[t * ns + s] += sigma * u[s] * v[t];
  }
  if (output === "residual") {
    const residual = new Float32Array(nt * ns);
    for (let i = 0; i < d.length; i++) residual[i] = d[i] - model[i];
    return { data: residual, numTraces: nt, numSamples: ns, components: sigmas.length, output };
  }
  return { data: model, numTraces: nt, numSamples: ns, components: sigmas.length, output: "model" };
}

function complexLeastSquares(rowsR, rowsI, yR, yI, muPercent) {
  const rows = rowsR.length, cols = rowsR[0]?.length || 0;
  const br = Array.from({ length: cols }, () => new Float64Array(cols));
  const bi = Array.from({ length: cols }, () => new Float64Array(cols));
  const rr = new Float64Array(cols), ri = new Float64Array(cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const acr = rowsR[r][c], aci = -rowsI[r][c];
      rr[c] += acr * yR[r] - aci * yI[r];
      ri[c] += acr * yI[r] + aci * yR[r];
      for (let k = 0; k < cols; k++) {
        const bcr = rowsR[r][k], bci = rowsI[r][k];
        br[c][k] += acr * bcr - aci * bci;
        bi[c][k] += acr * bci + aci * bcr;
      }
    }
  }
  const beta = Math.max(1e-12, Math.abs(br[0]?.[0] || 1) * safeNumber(muPercent, 1) / 100);
  for (let i = 0; i < cols; i++) br[i][i] += beta;
  return solveComplexLinear(br, bi, rr, ri);
}

function arModeling(xr, xi, lf, muPercent) {
  const nx = xr.length;
  lf = clamp(Math.floor(lf), 1, Math.max(1, Math.floor((nx - 1) / 2)));
  const rows = nx - lf;
  if (rows <= lf) return { yfR: Float64Array.from(xr), yfI: Float64Array.from(xi), ybR: Float64Array.from(xr), ybI: Float64Array.from(xi) };
  const ybR = new Float64Array(nx), ybI = new Float64Array(nx), yfR = new Float64Array(nx), yfI = new Float64Array(nx);
  const backR = [], backI = [], byR = new Float64Array(rows), byI = new Float64Array(rows);
  for (let r = 0; r < rows; r++) {
    const mr = new Float64Array(lf), mi = new Float64Array(lf);
    byR[r] = xr[r]; byI[r] = xi[r];
    for (let c = 0; c < lf; c++) { mr[c] = xr[r + c + 1]; mi[c] = xi[r + c + 1]; }
    backR.push(mr); backI.push(mi);
  }
  const ab = complexLeastSquares(backR, backI, byR, byI, muPercent);
  for (let r = 0; r < rows; r++) {
    let sr = 0, si = 0;
    for (let c = 0; c < lf; c++) {
      sr += backR[r][c] * ab.re[c] - backI[r][c] * ab.im[c];
      si += backR[r][c] * ab.im[c] + backI[r][c] * ab.re[c];
    }
    ybR[r] = sr; ybI[r] = si;
  }
  const forR = [], forI = [], fyR = new Float64Array(rows), fyI = new Float64Array(rows);
  for (let r = 0; r < rows; r++) {
    const mr = new Float64Array(lf), mi = new Float64Array(lf);
    fyR[r] = xr[lf + r]; fyI[r] = xi[lf + r];
    for (let c = 0; c < lf; c++) {
      const idx = lf + r - c - 1;
      mr[c] = xr[idx]; mi[c] = xi[idx];
    }
    forR.push(mr); forI.push(mi);
  }
  const af = complexLeastSquares(forR, forI, fyR, fyI, muPercent);
  for (let r = 0; r < rows; r++) {
    let sr = 0, si = 0;
    for (let c = 0; c < lf; c++) {
      sr += forR[r][c] * af.re[c] - forI[r][c] * af.im[c];
      si += forR[r][c] * af.im[c] + forI[r][c] * af.re[c];
    }
    yfR[lf + r] = sr; yfI[lf + r] = si;
  }
  return { yfR, yfI, ybR, ybI };
}

export function fxDecon(d, nt, ns, params = {}) {
  const dtNs = safeNumber(params.dtNs ?? params.dt, 0.625);
  const lf = Math.max(1, Math.floor(safeNumber(params.operatorLength ?? params.lf, 8)));
  const mu = safeNumber(params.muPercent ?? params.mu, 1);
  const flowGHz = safeNumber(params.flowMHz, 20) / 1000;
  const fhighGHz = safeNumber(params.fhighMHz, 1 / (2 * dtNs) * 1000) / 1000;
  const nfft = nextPow2(ns);
  const fxR = new Float64Array(nfft * nt), fxI = new Float64Array(nfft * nt);
  for (let t = 0; t < nt; t++) {
    const tr = new Float64Array(nfft), ti = new Float64Array(nfft);
    tr.set(d.subarray(t * ns, t * ns + ns));
    fft(tr, ti);
    for (let k = 0; k < nfft; k++) { fxR[k * nt + t] = tr[k]; fxI[k * nt + t] = ti[k]; }
  }
  const outFR = new Float64Array(nfft * nt), outFI = new Float64Array(nfft * nt);
  const outBR = new Float64Array(nfft * nt), outBI = new Float64Array(nfft * nt);
  const ilow = clamp(Math.floor(flowGHz * dtNs * nfft), 1, Math.floor(nfft / 2));
  const ihigh = clamp(Math.floor(fhighGHz * dtNs * nfft), ilow, Math.floor(nfft / 2));
  for (let k = ilow; k <= ihigh; k++) {
    const xr = fxR.slice(k * nt, k * nt + nt), xi = fxI.slice(k * nt, k * nt + nt);
    const { yfR, yfI, ybR, ybI } = arModeling(xr, xi, lf, mu);
    outFR.set(yfR, k * nt); outFI.set(yfI, k * nt);
    outBR.set(ybR, k * nt); outBI.set(ybI, k * nt);
  }
  for (let k = Math.floor(nfft / 2) + 1; k < nfft; k++) {
    const src = nfft - k;
    for (let t = 0; t < nt; t++) {
      outFR[k * nt + t] = outFR[src * nt + t]; outFI[k * nt + t] = -outFI[src * nt + t];
      outBR[k * nt + t] = outBR[src * nt + t]; outBI[k * nt + t] = -outBI[src * nt + t];
    }
  }
  const out = new Float32Array(nt * ns);
  for (let t = 0; t < nt; t++) {
    const fr = new Float64Array(nfft), fi = new Float64Array(nfft), br = new Float64Array(nfft), bi = new Float64Array(nfft);
    for (let k = 0; k < nfft; k++) {
      fr[k] = outFR[k * nt + t]; fi[k] = outFI[k * nt + t];
      br[k] = outBR[k * nt + t]; bi[k] = outBI[k * nt + t];
    }
    fft(fr, fi, true); fft(br, bi, true);
    const div = t >= lf && t < nt - lf ? 2 : 1;
    for (let s = 0; s < ns; s++) out[t * ns + s] = (fr[s] + br[s]) / div;
  }
  return { data: out, numTraces: nt, numSamples: ns, operatorLength: lf, muPercent: mu };
}

function rickerWavelet(freqMHz, dtNs, lengthSamples) {
  const n = Math.max(5, Math.floor(lengthSamples) | 1);
  const f = Math.max(1e-6, freqMHz / 1000);
  const mid = Math.floor(n / 2);
  const w = new Float64Array(n);
  let e = 0;
  for (let i = 0; i < n; i++) {
    const t = (i - mid) * dtNs;
    const a = Math.PI * Math.PI * f * f * t * t;
    w[i] = (1 - 2 * a) * Math.exp(-a);
    e += w[i] * w[i];
  }
  e = Math.sqrt(e) || 1;
  for (let i = 0; i < n; i++) w[i] /= e;
  return w;
}

function convolveWavelet(x, w) {
  const y = new Float64Array(x.length + w.length - 1);
  for (let i = 0; i < x.length; i++) for (let j = 0; j < w.length; j++) y[i + j] += x[i] * w[j];
  return y;
}

function correlateWavelet(y, w, n) {
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) for (let j = 0; j < w.length; j++) x[i] += (y[i + j] || 0) * w[j];
  return x;
}

function conjugateGradient(apply, b, maxIter = 80, tol = 1e-7) {
  const n = b.length, x = new Float64Array(n), r = Float64Array.from(b), p = Float64Array.from(r);
  let rs = dot(r, r);
  const target = Math.max(tol * tol * rs, 1e-18);
  for (let iter = 0; iter < maxIter && rs > target; iter++) {
    const Ap = apply(p);
    const alpha = rs / Math.max(1e-18, dot(p, Ap));
    for (let i = 0; i < n; i++) { x[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; }
    const nr = dot(r, r), beta = nr / Math.max(1e-18, rs);
    for (let i = 0; i < n; i++) p[i] = r[i] + beta * p[i];
    rs = nr;
  }
  return x;
}

export function sparseDecon(d, nt, ns, params = {}) {
  const dtNs = safeNumber(params.dtNs ?? params.dt, 0.625);
  const w = params.wavelet ? Float64Array.from(params.wavelet) : rickerWavelet(safeNumber(params.frequencyMHz, 100), dtNs, safeNumber(params.lengthSamples, 64));
  const mu = Math.max(0, safeNumber(params.mu, 0.01));
  const iterMax = Math.max(1, Math.floor(safeNumber(params.iterations ?? params.iterMax, 10)));
  const output = String(params.output || "reflectivity").toLowerCase();
  const refl = new Float32Array(nt * ns), pred = new Float32Array(nt * ns);
  let r0 = 0;
  for (const v of w) r0 += v * v;
  r0 *= ns;
  for (let t = 0; t < nt; t++) {
    const sPad = new Float64Array(ns + w.length - 1);
    sPad.set(d.subarray(t * ns, t * ns + ns));
    const g = correlateWavelet(sPad, w, ns);
    let q = new Float64Array(ns);
    q.fill(mu * r0);
    let r = new Float64Array(ns);
    for (let iter = 0; iter < iterMax; iter++) {
      const apply = x => {
        const wx = convolveWavelet(x, w);
        const y = correlateWavelet(wx, w, ns);
        for (let i = 0; i < ns; i++) y[i] += q[i] * x[i];
        return y;
      };
      r = conjugateGradient(apply, g, Math.min(120, ns * 2), 1e-6);
      for (let i = 0; i < ns; i++) q[i] = mu / (Math.abs(r[i]) + 0.0001);
    }
    const shift = Math.floor(w.length / 2);
    for (let s = 0; s < ns; s++) refl[t * ns + s] = s >= shift ? r[s - shift] : 0;
    const dp = convolveWavelet(r, w);
    for (let s = 0; s < ns; s++) pred[t * ns + s] = dp[s] || 0;
  }
  return { data: output === "predicted" ? pred : refl, predicted: pred, numTraces: nt, numSamples: ns, wavelet: Float32Array.from(w), output };
}

export function attenuationAnalysis(d, nt, ns, params = {}) {
  const dtNs = safeNumber(params.dtNs ?? params.dt, 0.625);
  const tt = Float64Array.from({ length: ns }, (_, s) => s * dtNs);
  const medianPower = attenuationCurve(d, nt, ns, "power", "median");
  const meanPower = attenuationCurve(d, nt, ns, "power", "mean");
  const fit = (kind) => {
    const start = kind === "power" ? [Math.max(...medianPower), -2] : [Math.max(...medianPower), -1];
    return fminsearch(a => {
      const amp = Math.max(1e-18, Math.abs(a[0]));
      let err = 0, n = 0;
      for (let s = 1; s < ns; s++) {
        const model = kind === "power" ? amp * (tt[s] ** a[1]) : amp * Math.exp(a[1] * tt[s]);
        if (!Number.isFinite(model) || model <= 0 || medianPower[s] <= 0) continue;
        const e = Math.log10(medianPower[s]) - Math.log10(model);
        err += e * e; n++;
      }
      return Math.sqrt(err / Math.max(1, n));
    }, start, { maxIter: 220, tol: 1e-6 });
  };
  const p = fit("power"), e = fit("exp");
  p[0] = Math.abs(p[0]); e[0] = Math.abs(e[0]);
  const out = new Float32Array(4 * ns);
  for (let s = 0; s < ns; s++) {
    out[s] = medianPower[s];
    out[ns + s] = meanPower[s];
    out[2 * ns + s] = s === 0 ? medianPower[0] : p[0] * (tt[s] ** p[1]);
    out[3 * ns + s] = e[0] * Math.exp(e[1] * tt[s]);
  }
  return { data: out, numTraces: 4, numSamples: ns, powerLaw: p, exponential: e, attenuationKind: "power" };
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

function lineDepthStats(line) {
  let minDepth = Infinity, maxDepth = -Infinity, meanDepth = 0;
  for (const z of line) {
    minDepth = Math.min(minDepth, z);
    maxDepth = Math.max(maxDepth, z);
    meanDepth += z;
  }
  meanDepth /= line.length || 1;
  return { minDepth, maxDepth, meanDepth, medianDepth: medianTyped(line) };
}

function enforceLineBelowPrevious(line, previous, minGap) {
  if (!previous) return line;
  for (let i = 0; i < line.length; i++) {
    const requiredDepth = previous[i] + minGap;
    if (line[i] < requiredDepth) line[i] = requiredDepth;
  }
  return line;
}

const GEO_LABELS = [
  "upper regolith / disturbed shallow layer",
  "layered regolith unit A",
  "layered regolith unit B",
  "strong reflector package",
  "deeper weakly resolved material",
  "deep noisy tail",
  "unclassified"
];

const GEO_MEANINGS = [
  "Upper disturbed regolith above the first continuous reflector.",
  "Layered regolith package bounded by shallow continuous reflectors.",
  "Thin layered transition with a clear dielectric contrast.",
  "Laterally persistent strong reflection package.",
  "Weakly resolved material below the tracked reflector package.",
  "Deep interval with lower continuity and higher uncertainty."
];

function geoParams(params = {}, ns = 1) {
  const dt = Number(params.dt ?? params.dtNs) || 0.3125;
  const dx = Number(params.dx ?? params.dxM) || 0.05;
  const velocity = Number(params.velocity) || 0.1;
  const autoMode = String(params.autoMode || "conservative").toLowerCase() === "complete" ? "complete" : "conservative";
  const depthStep = Math.max(1e-6, velocity * dt / 2);
  const modelDepthMax = Number(params.modelDepthMax) || Math.min(24, (ns - 1) * depthStep);
  const startSample = Math.max(0, Math.floor((Number(params.startDepth) || depthStep * 4) / depthStep));
  const endSample = Math.min(ns - 2, Math.ceil((Number(params.endDepth) || Math.min(modelDepthMax, (ns - 1) * depthStep)) / depthStep));
  const peakSepM = Number(params.minHorizonSeparation) || (autoMode === "complete" ? 0.25 : 0.35);
  const trackWindowM = Number(params.trackHalfWindow) || (autoMode === "complete" ? 1.1 : 0.75);
  return {
    dt,
    dx,
    velocity,
    autoMode,
    useMigration: params.useMigration === true,
    qualityThreshold: Number(params.qualityThreshold) || 70,
    loMHz: Number(params.loMHz) || 20,
    hiMHz: Number(params.hiMHz) || 900,
    bgWidth: Number(params.bgWidth) || 25,
    agcWindow: Number(params.agcWindow) || 80,
    modelDepthMax,
    sampleRate: 1 / (dt * 1e-9),
    depthStep,
    startSample,
    endSample,
    minSepSamples: Math.max(2, Math.round(peakSepM / depthStep)),
    maxPeaksPerTrace: clamp(Math.floor(Number(params.maxPeaksPerTrace) || 8), 1, 14),
    binSize: Number(params.binSizeM) || Math.max(0.08, depthStep * 8),
    histPercentile: Number(params.histPercentile) || (autoMode === "complete" ? 0.58 : 0.68),
    clusterSearchM: Number(params.clusterSearchM) || (autoMode === "complete" ? 0.65 : 0.5),
    mergeDistanceM: Number(params.mergeDistanceM) || (autoMode === "complete" ? 0.45 : 0.35),
    supportThreshold: Number(params.supportThreshold) || (autoMode === "complete" ? 0.08 : 0.16),
    maxHorizons: clamp(Math.floor(Number(params.maxHorizons) || (autoMode === "complete" ? 8 : 3)), 1, 12),
    trackHalfWindow: trackWindowM,
    horizonMinGapM: Number(params.horizonMinGapM) || Math.max(0.12, peakSepM * 0.5),
    modelSamples: Number(params.modelSamples) || 480,
    semblanceTraceRadius: clamp(Math.floor(Number(params.semblanceTraceRadius) || 3), 1, 8),
    semblanceSampleRadius: clamp(Math.floor(Number(params.semblanceSampleRadius) || 2), 1, 8),
    maxJumpSamples: Math.max(2, Math.round((Number(params.maxJumpM) || (autoMode === "complete" ? 0.35 : 0.24)) / depthStep)),
    confidenceCutoff: Number(params.confidenceCutoff) || (autoMode === "complete" ? 38 : 52)
  };
}

function finiteMean(values) {
  let sum = 0, n = 0;
  for (const v of values) if (Number.isFinite(v)) { sum += v; n++; }
  return n ? sum / n : 0;
}

function robustScaleTrace(values, start = 0, end = values.length - 1) {
  const slice = [];
  for (let i = Math.max(0, start); i <= Math.min(values.length - 1, end); i++) {
    const v = Math.abs(values[i]);
    if (Number.isFinite(v)) slice.push(v);
  }
  if (!slice.length) return 1;
  return Math.max(percentile(slice, 0.9), percentile(slice, 0.5) * 2, 1e-9);
}

function estimateFrequencyBand(d, nt, ns, dtNs) {
  const step = Math.max(1, Math.floor(nt / 16));
  const n = nextPow2(ns), half = n / 2;
  const accum = new Float64Array(half);
  let traces = 0;
  for (let t = 0; t < nt; t += step) {
    const sp = spectrum(d.subarray(t * ns, t * ns + ns));
    for (let i = 0; i < Math.min(half, sp.length); i++) accum[i] += sp[i];
    traces++;
  }
  if (!traces) return { peakMHz: 0, lowMHz: 0, highMHz: 0, bandwidthMHz: 0 };
  let peak = 1, max = 0;
  for (let i = 1; i < half; i++) {
    accum[i] /= traces;
    if (accum[i] > max) { max = accum[i]; peak = i; }
  }
  const dfMHz = (1 / (dtNs * 1e-9)) / n / 1e6;
  const cutoff = max * 0.5;
  let lo = peak, hi = peak;
  while (lo > 1 && accum[lo] > cutoff) lo--;
  while (hi < half - 1 && accum[hi] > cutoff) hi++;
  return {
    peakMHz: peak * dfMHz,
    lowMHz: lo * dfMHz,
    highMHz: hi * dfMHz,
    bandwidthMHz: Math.max(0, (hi - lo) * dfMHz)
  };
}

function diagnoseGeologyData(d, nt, ns, gp) {
  const rmsByTrace = new Float64Array(nt);
  let global = 0, count = 0;
  for (let t = 0; t < nt; t++) {
    let sum = 0;
    for (let s = 0; s < ns; s++) {
      const v = d[t * ns + s];
      sum += v * v;
    }
    rmsByTrace[t] = Math.sqrt(sum / Math.max(1, ns));
    global += rmsByTrace[t];
    count++;
  }
  const rmsMean = global / Math.max(1, count);
  const rmsMedian = medianTyped(rmsByTrace);
  let bad = 0;
  for (const v of rmsByTrace) if (!Number.isFinite(v) || v < rmsMedian * 0.08 || v > rmsMedian * 8) bad++;
  const band = estimateFrequencyBand(d, nt, ns, gp.dt);
  const depthEnergy = new Float64Array(ns);
  for (let s = 0; s < ns; s++) {
    let row = 0;
    for (let t = 0; t < nt; t++) row += Math.abs(d[t * ns + s]);
    depthEnergy[s] = row / Math.max(1, nt);
  }
  const ref = percentile(depthEnergy, 0.75) || 1;
  let effectiveSample = Math.min(ns - 1, gp.endSample);
  for (let s = gp.startSample; s < gp.endSample; s++) {
    if (depthEnergy[s] < ref * 0.12) { effectiveSample = s; break; }
  }
  return {
    rmsMean,
    rmsMedian,
    badTraceRatio: bad / Math.max(1, nt),
    effectiveDepthM: effectiveSample * gp.depthStep,
    frequency: band,
    autoMode: gp.autoMode
  };
}

function geologyPreprocess(d, nt, ns, params = {}) {
  const gp = geoParams(params, ns);
  const preprocess = params.preprocess || {};
  let r = new Float32Array(d);
  if (preprocess.dewow !== false) r = dewow(r, nt, ns).data;
  if (preprocess.dc !== false) r = removeDC(r, nt, ns).data;
  if (preprocess.freqFilter !== false) r = freqFilter(r, nt, ns, "bp", gp.loMHz * 1e6, gp.hiMHz * 1e6, gp.sampleRate).data;
  if (preprocess.backgroundRemove !== false) r = backgroundRemove(r, nt, ns).data;
  if (preprocess.slidingBg !== false) r = slidingBackground(r, nt, ns, gp.bgWidth, "remove").data;
  if (preprocess.equalize === true) r = equalize(r, nt, ns).data;
  const gainMethod = preprocess.gainMethod || params.gainMethod || "gagc";
  if (gainMethod === "agc") r = agc(r, nt, ns, gp.agcWindow, false).data;
  else if (gainMethod === "power") r = powerGain(r, nt, ns, { power: "auto", dtNs: gp.dt }).data;
  else if (gainMethod === "amplitude") r = amplitudeGain(r, nt, ns, { dtNs: gp.dt }).data;
  else r = agc(r, nt, ns, gp.agcWindow, true).data;
  const clip = Number(params.clip) || 4;
  for (let i = 0; i < r.length; i++) {
    if (r[i] > clip) r[i] = clip;
    else if (r[i] < -clip) r[i] = -clip;
  }
  return { data: r, gp, diagnosis: diagnoseGeologyData(r, nt, ns, gp) };
}

function computeGeologyFeatureMaps(processed, nt, ns, gp) {
  const envelope = new Float32Array(processed.length);
  const phase = new Float32Array(processed.length);
  const instantFreq = new Float32Array(processed.length);
  const polarity = new Float32Array(processed.length);
  const phaseChange = new Float32Array(processed.length);
  const envelopeNorm = new Float32Array(processed.length);
  for (let t = 0; t < nt; t++) {
    const h = hilbert(processed.subarray(t * ns, t * ns + ns), 2);
    const unwrapped = new Float64Array(ns);
    for (let s = 0; s < ns; s++) {
      const idx = t * ns + s;
      const ph = Math.atan2(h.im[s], h.re[s]);
      phase[idx] = ph;
      unwrapped[s] = ph;
      envelope[idx] = Math.hypot(h.re[s], h.im[s]);
      polarity[idx] = processed[idx] >= 0 ? 1 : -1;
    }
    for (let s = 1; s < ns; s++) {
      while (unwrapped[s] - unwrapped[s - 1] > Math.PI) unwrapped[s] -= 2 * Math.PI;
      while (unwrapped[s] - unwrapped[s - 1] < -Math.PI) unwrapped[s] += 2 * Math.PI;
    }
    const scale = robustScaleTrace(envelope.subarray(t * ns, t * ns + ns), gp.startSample, gp.endSample);
    for (let s = 1; s < ns; s++) {
      const idx = t * ns + s;
      const depthGain = Math.sqrt(1 + s / Math.max(1, ns - 1));
      envelopeNorm[idx] = clamp((envelope[idx] / scale) * depthGain, 0, 1.35);
      instantFreq[idx] = (unwrapped[s] - unwrapped[s - 1]) / (2 * Math.PI * gp.dt);
      phaseChange[idx] = clamp(Math.abs(unwrapped[s] - unwrapped[s - 1]) / Math.PI, 0, 1);
    }
  }

  const semblance = new Float32Array(processed.length);
  const tr = gp.semblanceTraceRadius, sr = gp.semblanceSampleRadius;
  for (let t = 0; t < nt; t++) {
    for (let s = gp.startSample; s <= gp.endSample; s++) {
      let sum = 0, sumSq = 0, n = 0;
      for (let tt = Math.max(0, t - tr); tt <= Math.min(nt - 1, t + tr); tt++) {
        for (let ss = Math.max(0, s - sr); ss <= Math.min(ns - 1, s + sr); ss++) {
          const v = processed[tt * ns + ss];
          sum += v; sumSq += v * v; n++;
        }
      }
      semblance[t * ns + s] = sumSq > 1e-18 ? clamp((sum * sum) / (n * sumSq), 0, 1) : 0;
    }
  }

  const dipResponse = new Float32Array(processed.length);
  const slopes = [-2, -1, 0, 1, 2];
  for (let t = 0; t < nt; t++) {
    for (let s = gp.startSample; s <= gp.endSample; s++) {
      let best = 0;
      for (const slope of slopes) {
        let acc = 0, n = 0;
        for (let dt = -2; dt <= 2; dt++) {
          const tt = t + dt;
          const ss = Math.round(s + slope * dt);
          if (tt < 0 || tt >= nt || ss < 0 || ss >= ns) continue;
          acc += envelopeNorm[tt * ns + ss];
          n++;
        }
        if (n) best = Math.max(best, acc / n);
      }
      dipResponse[t * ns + s] = clamp(best, 0, 1);
    }
  }

  const boundaryProbability = new Float32Array(processed.length);
  for (let i = 0; i < processed.length; i++) {
    const ifq = clamp(Math.abs(instantFreq[i]) / Math.max(0.05, gp.hiMHz / 1000), 0, 1);
    const score = 0.38 * clamp(envelopeNorm[i], 0, 1) + 0.24 * semblance[i] + 0.18 * dipResponse[i] + 0.12 * phaseChange[i] + 0.08 * ifq;
    boundaryProbability[i] = clamp(score, 0, 1);
  }
  const smoothProb = smoothTraces(smoothSamples(boundaryProbability, nt, ns, 5), nt, ns, 5);
  for (let i = 0; i < boundaryProbability.length; i++) boundaryProbability[i] = 0.65 * boundaryProbability[i] + 0.35 * smoothProb[i];

  return {
    envelope,
    phase,
    instantFreq,
    polarity,
    phaseChange,
    semblance,
    dipResponse,
    boundaryProbability
  };
}

export function geologyEnergyEnvelope(d, nt, ns, params = {}) {
  const pre = geologyPreprocess(d, nt, ns, params);
  const featureMaps = computeGeologyFeatureMaps(pre.data, nt, ns, pre.gp);
  return {
    data: featureMaps.envelope,
    processedData: pre.data,
    boundaryProbability: featureMaps.boundaryProbability,
    featureMaps,
    diagnosis: pre.diagnosis,
    numTraces: nt,
    numSamples: ns,
    ...pre.gp,
    step: "energy-envelope"
  };
}

export function geologySmooth2D(d, nt, ns, params = {}) {
  const energy = geologyEnergyEnvelope(d, nt, ns, params);
  const sampleWidth = Number(params.energySampleSmooth) || 9;
  const traceWidth = Number(params.energyTraceSmooth) || 7;
  const smoothed = smoothTraces(smoothSamples(energy.boundaryProbability, nt, ns, sampleWidth), nt, ns, traceWidth);
  const edgeKept = new Float32Array(smoothed.length);
  for (let i = 0; i < smoothed.length; i++) edgeKept[i] = clamp(0.72 * smoothed[i] + 0.28 * energy.boundaryProbability[i], 0, 1);
  return { ...energy, data: edgeKept, probabilityData: edgeKept, energyData: energy.data, step: "smooth-2d", sampleWidth, traceWidth };
}

export function geologyTracePeaks(d, nt, ns, params = {}) {
  const smooth = geologySmooth2D(d, nt, ns, params);
  const peaks = [];
  for (let t = 0; t < nt; t++) {
    const trace = smooth.data.subarray(t * ns, t * ns + ns);
    const localThreshold = Math.max(percentile(trace.subarray(smooth.startSample, smooth.endSample + 1), smooth.autoMode === "complete" ? 0.58 : 0.68), 0.12);
    const candidates = [];
    for (let s = smooth.startSample + 1; s < smooth.endSample - 1; s++) {
      const v = trace[s];
      if (v < localThreshold) continue;
      if (v > trace[s - 1] && v >= trace[s + 1]) {
        const idx = t * ns + s;
        const coherence = smooth.featureMaps.semblance[idx] || 0;
        const phaseScore = 1 - Math.min(1, smooth.featureMaps.phaseChange[idx] || 0);
        candidates.push({ s, v, score: v * (0.65 + 0.35 * coherence) * (0.8 + 0.2 * phaseScore) });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    const chosen = [];
    for (const c of candidates) {
      if (chosen.every(p => Math.abs(p.s - c.s) >= smooth.minSepSamples)) chosen.push(c);
      if (chosen.length >= smooth.maxPeaksPerTrace) break;
    }
    if (!chosen.length) {
      let bestS = smooth.startSample, best = -Infinity;
      for (let s = smooth.startSample; s <= smooth.endSample; s++) if (trace[s] > best) { best = trace[s]; bestS = s; }
      if (best > 0) chosen.push({ s: bestS, v: best, score: best });
    }
    for (const c of chosen) {
      const idx = t * ns + c.s;
      peaks.push({
        t,
        sample: c.s,
        depth: c.s * smooth.depthStep,
        strength: c.v,
        score: c.score,
        phase: smooth.featureMaps.phase[idx],
        semblance: smooth.featureMaps.semblance[idx],
        polarity: smooth.featureMaps.polarity[idx]
      });
    }
  }
  return { ...smooth, peaks, step: "trace-peaks" };
}

export function geologyDepthHistogram(d, nt, ns, params = {}) {
  const peakResult = geologyTracePeaks(d, nt, ns, params);
  const binStart = peakResult.startSample * peakResult.depthStep;
  const binEnd = peakResult.endSample * peakResult.depthStep;
  const binCount = Math.max(1, Math.ceil((binEnd - binStart) / peakResult.binSize));
  const hist = new Float32Array(binCount);
  for (const p of peakResult.peaks) {
    const bi = Math.floor((p.depth - binStart) / peakResult.binSize);
    if (bi >= 0 && bi < binCount) hist[bi] += p.score || p.strength;
  }
  return { ...peakResult, histogram: hist, binStart, binEnd, binCount, step: "depth-histogram" };
}

function peakSlopeSamples(peaks, ns) {
  if (peaks.length < 3) return 0;
  const meanT = finiteMean(peaks.map(p => p.t));
  const meanS = finiteMean(peaks.map(p => p.sample));
  let num = 0, den = 0;
  for (const p of peaks) {
    num += (p.t - meanT) * (p.sample - meanS);
    den += (p.t - meanT) * (p.t - meanT);
  }
  return clamp(den ? num / den : 0, -Math.max(2, ns * 0.01), Math.max(2, ns * 0.01));
}

export function geologyClusterPeaks(d, nt, ns, params = {}) {
  const histResult = geologyDepthHistogram(d, nt, ns, params);
  const histThreshold = percentile(histResult.histogram, histResult.histPercentile);
  const clusters = [];
  const makeCluster = (members, depth, dipSamplesPerTrace = 0) => {
    if (!members.length) return null;
    const traces = new Set();
    let sumDepth = 0, sumWeight = 0, strength = 0, phaseR = 0, phaseI = 0, sem = 0;
    for (const p of members) {
      const w = Math.max(1e-6, p.score || p.strength);
      traces.add(p.t);
      sumDepth += p.depth * w;
      sumWeight += w;
      strength += w;
      phaseR += Math.cos(p.phase || 0) * w;
      phaseI += Math.sin(p.phase || 0) * w;
      sem += p.semblance || 0;
    }
    return {
      depth: Number.isFinite(depth) ? depth : sumDepth / Math.max(sumWeight, 1e-9),
      support: members.length,
      traceSupport: traces.size,
      coverage: traces.size / Math.max(1, nt),
      strength: strength / members.length,
      meanSemblance: sem / members.length,
      meanPhase: Math.atan2(phaseI, phaseR),
      dipSamplesPerTrace: dipSamplesPerTrace || peakSlopeSamples(members, ns),
      members: members.length
    };
  };
  for (let i = 1; i < histResult.binCount - 1; i++) {
    if (!(histResult.histogram[i] >= histResult.histogram[i - 1] && histResult.histogram[i] > histResult.histogram[i + 1] && histResult.histogram[i] > histThreshold)) continue;
    const center = histResult.binStart + (i + 0.5) * histResult.binSize;
    const members = [];
    for (const p of histResult.peaks) if (Math.abs(p.depth - center) <= histResult.clusterSearchM) members.push(p);
    const c = makeCluster(members, NaN, 0);
    if (c) clusters.push(c);
  }
  const dipSlopes = [-0.6, -0.35, -0.18, 0.18, 0.35, 0.6];
  const traceMid = (nt - 1) / 2;
  for (const slope of dipSlopes) {
    const dipHist = new Float32Array(histResult.binCount);
    for (const p of histResult.peaks) {
      const projected = p.depth - slope * (p.t - traceMid) * histResult.depthStep;
      const bi = Math.floor((projected - histResult.binStart) / histResult.binSize);
      if (bi >= 0 && bi < dipHist.length) dipHist[bi] += p.score || p.strength;
    }
    const dipThreshold = percentile(dipHist, 0.7);
    for (let i = 1; i < dipHist.length - 1; i++) {
      if (!(dipHist[i] >= dipHist[i - 1] && dipHist[i] > dipHist[i + 1] && dipHist[i] > dipThreshold)) continue;
      const center = histResult.binStart + (i + 0.5) * histResult.binSize;
      const members = [];
      for (const p of histResult.peaks) {
        const projected = p.depth - slope * (p.t - traceMid) * histResult.depthStep;
        if (Math.abs(projected - center) <= histResult.clusterSearchM) members.push(p);
      }
      const c = makeCluster(members, center, slope);
      if (c && c.coverage > histResult.supportThreshold && c.meanSemblance > 0.18) clusters.push(c);
    }
  }
  return { ...histResult, clusters, histThreshold, step: "cluster-peaks" };
}

export function geologyMergeClusters(d, nt, ns, params = {}) {
  const clusterResult = geologyClusterPeaks(d, nt, ns, params);
  const merged = [];
  for (const c of clusterResult.clusters.sort((a, b) => a.depth - b.depth)) {
    const last = merged[merged.length - 1];
    const phaseClose = last ? Math.abs(Math.atan2(Math.sin(c.meanPhase - last.meanPhase), Math.cos(c.meanPhase - last.meanPhase))) < Math.PI * 0.65 : false;
    const dipClose = last ? Math.abs(c.dipSamplesPerTrace - last.dipSamplesPerTrace) < 1.5 : false;
    if (last && Math.abs(c.depth - last.depth) < clusterResult.mergeDistanceM && (phaseClose || dipClose)) {
      const total = last.support + c.support;
      last.depth = (last.depth * last.support + c.depth * c.support) / Math.max(1, total);
      last.support = total;
      last.traceSupport += c.traceSupport;
      last.coverage = Math.min(1, Math.max(last.coverage, c.coverage));
      last.strength = Math.max(last.strength, c.strength);
      last.meanSemblance = Math.max(last.meanSemblance, c.meanSemblance);
      last.dipSamplesPerTrace = (last.dipSamplesPerTrace + c.dipSamplesPerTrace) / 2;
      last.members += c.members;
    } else merged.push({ ...c });
  }
  return { ...clusterResult, mergedClusters: merged, step: "merge-clusters" };
}

export function geologySelectSupported(d, nt, ns, params = {}) {
  const mergedResult = geologyMergeClusters(d, nt, ns, params);
  const minScore = mergedResult.autoMode === "complete" ? 0.45 : 0.55;
  let seeds = mergedResult.mergedClusters
    .map(c => ({ ...c, supportScore: c.coverage * 0.45 + c.meanSemblance * 0.35 + Math.min(1, c.strength) * 0.2 }))
    .filter(c => (c.coverage >= mergedResult.supportThreshold || c.meanSemblance > 0.28) && c.supportScore >= minScore);
  if (seeds.length < 2) seeds = mergedResult.mergedClusters.slice().sort((a, b) => (b.coverage * b.strength) - (a.coverage * a.strength)).slice(0, mergedResult.maxHorizons);
  seeds = (mergedResult.autoMode === "conservative"
    ? seeds.sort((a, b) => a.depth - b.depth)
    : seeds.sort((a, b) => (b.supportScore ?? (b.coverage * 2 + b.meanSemblance + b.strength)) - (a.supportScore ?? (a.coverage * 2 + a.meanSemblance + a.strength))))
    .slice(0, mergedResult.maxHorizons)
    .sort((a, b) => a.depth - b.depth);
  return { ...mergedResult, seeds, step: "support-select" };
}

function confidenceSegments(confidence, cutoff) {
  const segments = [];
  let start = -1;
  for (let i = 0; i < confidence.length; i++) {
    if (confidence[i] >= cutoff && start < 0) start = i;
    if ((confidence[i] < cutoff || i === confidence.length - 1) && start >= 0) {
      const end = confidence[i] < cutoff ? i - 1 : i;
      if (end >= start) segments.push({ startTrace: start, endTrace: end, source: "auto" });
      start = -1;
    }
  }
  return segments;
}

function trackHorizonViterbi(prob, nt, ns, seed, gp, previousLine, featureMaps) {
  const centerS = clamp(Math.round(seed.depth / gp.depthStep), gp.startSample, gp.endSample);
  const half = Math.max(4, Math.round(gp.trackHalfWindow / gp.depthStep));
  const sMin = Math.max(gp.startSample, centerS - half);
  const sMax = Math.min(gp.endSample, centerS + half);
  const states = [];
  for (let s = sMin; s <= sMax; s++) states.push(s);
  const nState = states.length;
  const dp = new Float64Array(nt * nState);
  const prev = new Int16Array(nt * nState);
  dp.fill(Infinity);
  prev.fill(-1);
  const expectedDip = Number(seed.dipSamplesPerTrace) || 0;
  const gapSamples = Math.max(1, Math.round(gp.horizonMinGapM / gp.depthStep));
  for (let t = 0; t < nt; t++) {
    for (let si = 0; si < nState; si++) {
      const s = states[si];
      if (previousLine && s <= Math.round(previousLine[t] / gp.depthStep) + gapSamples) continue;
      const idx = t * ns + s;
      const p = clamp(prob[idx], 0, 1);
      const sem = featureMaps?.semblance?.[idx] || 0;
      const local = -Math.log(0.015 + p) + (1 - sem) * 0.35;
      const cell = t * nState + si;
      if (t === 0) {
        dp[cell] = local + Math.abs(s - centerS) / Math.max(1, half) * 0.25;
        continue;
      }
      let best = Infinity, bestPi = -1;
      for (let pi = 0; pi < nState; pi++) {
        const ps = states[pi];
        const jump = s - ps;
        if (Math.abs(jump) > gp.maxJumpSamples * 3) continue;
        const prevCost = dp[(t - 1) * nState + pi];
        if (!Number.isFinite(prevCost)) continue;
        const smoothCost = (jump * jump) / Math.max(1, gp.maxJumpSamples * gp.maxJumpSamples);
        const dipCost = Math.abs(jump - expectedDip) / Math.max(1, gp.maxJumpSamples);
        const cost = prevCost + local + 0.65 * smoothCost + 0.18 * dipCost;
        if (cost < best) { best = cost; bestPi = pi; }
      }
      dp[cell] = best;
      prev[cell] = bestPi;
    }
  }
  let endState = -1, best = Infinity;
  for (let si = 0; si < nState; si++) {
    const cost = dp[(nt - 1) * nState + si];
    if (cost < best) { best = cost; endState = si; }
  }
  const line = new Float32Array(nt);
  const confidence = new Float32Array(nt);
  if (endState < 0) {
    for (let t = 0; t < nt; t++) {
      let bestS = centerS, bestP = -1;
      for (const s of states) {
        if (previousLine && s <= Math.round(previousLine[t] / gp.depthStep) + gapSamples) continue;
        const p = prob[t * ns + s];
        if (p > bestP) { bestP = p; bestS = s; }
      }
      line[t] = bestS * gp.depthStep;
      confidence[t] = clamp(bestP * 100, 0, 100);
    }
  } else {
    let si = endState;
    for (let t = nt - 1; t >= 0; t--) {
      const s = states[si] ?? centerS;
      const idx = t * ns + s;
      line[t] = s * gp.depthStep;
      confidence[t] = clamp((prob[idx] * 0.72 + (featureMaps?.semblance?.[idx] || 0) * 0.28) * 100, 0, 100);
      si = prev[t * nState + si];
      if (si < 0 && t > 0) si = endState;
    }
  }
  return { line, confidence, pathCost: best };
}

export function geologyTrackHorizons(d, nt, ns, params = {}) {
  const seedResult = geologySelectSupported(d, nt, ns, params);
  const horizons = [];
  const prob = seedResult.data;
  for (let i = 0; i < seedResult.seeds.length; i++) {
    const seed = seedResult.seeds[i];
    const previousLine = horizons[horizons.length - 1]?.line;
    const tracked = trackHorizonViterbi(prob, nt, ns, seed, seedResult, previousLine, seedResult.featureMaps);
    const stats = lineDepthStats(tracked.line);
    const meanConfidence = finiteMean(tracked.confidence);
    const warnings = [];
    const cov = Array.from(tracked.confidence).filter(v => v >= seedResult.confidenceCutoff).length / Math.max(1, nt);
    if (meanConfidence < seedResult.qualityThreshold) warnings.push("low-confidence horizon");
    if (cov < 0.45) warnings.push("limited lateral coverage");
    horizons.push({
      name: `H${horizons.length + 1}`,
      meanDepth: stats.meanDepth,
      medianDepth: stats.medianDepth,
      minDepth: stats.minDepth,
      maxDepth: stats.maxDepth,
      support: seed.support,
      coverage: cov,
      meanStrength: seed.strength,
      meanConfidence,
      confidence: tracked.confidence,
      segments: confidenceSegments(tracked.confidence, seedResult.confidenceCutoff),
      warnings,
      source: "auto",
      layerName: GEO_LABELS[Math.min(horizons.length, GEO_LABELS.length - 1)],
      meaning: GEO_MEANINGS[Math.min(horizons.length, GEO_MEANINGS.length - 1)],
      line: tracked.line
    });
  }
  return { ...seedResult, horizons, horizonMinGapSamples: Math.max(1, Math.round(seedResult.horizonMinGapM / seedResult.depthStep)), step: "track-horizons" };
}

function smoothLineWeighted(line, confidence, width = 41) {
  const out = new Float32Array(line.length);
  const h = Math.max(1, Math.floor(width / 2));
  for (let i = 0; i < line.length; i++) {
    let sum = 0, wsum = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(line.length - 1, i + h); j++) {
      const dist = Math.abs(i - j) / Math.max(1, h);
      const kernel = Math.exp(-2.8 * dist * dist);
      const w = kernel * (0.25 + 0.75 * clamp((confidence?.[j] || 0) / 100, 0, 1));
      sum += line[j] * w;
      wsum += w;
    }
    const sm = wsum ? sum / wsum : line[i];
    const keep = clamp((confidence?.[i] || 0) / 100, 0.2, 0.9);
    out[i] = line[i] * keep + sm * (1 - keep);
  }
  return out;
}

export function geologySmoothHorizonLines(d, nt, ns, params = {}) {
  const tracked = geologyTrackHorizons(d, nt, ns, params);
  const horizons = tracked.horizons.map((h, i) => {
    const line = smoothLineWeighted(h.line, h.confidence, Number(params.lineSmoothWidth) || 41);
    const stats = lineDepthStats(line);
    return { ...h, name: `H${i + 1}`, ...stats, line, stepSource: "confidence-weighted-smooth" };
  });
  return { ...tracked, horizons, step: "line-smooth" };
}

export function geologyEnforceStratigraphy(d, nt, ns, params = {}) {
  const smoothed = geologySmoothHorizonLines(d, nt, ns, params);
  const horizonMinGapDepth = Math.max(smoothed.depthStep, smoothed.horizonMinGapM);
  const horizons = [];
  for (let i = 0; i < smoothed.horizons.length; i++) {
    const h = smoothed.horizons[i];
    const line = new Float32Array(h.line);
    const warnings = [...(h.warnings || [])];
    let repairs = 0;
    const prev = horizons[i - 1]?.line;
    if (prev) {
      for (let t = 0; t < nt; t++) {
        const minDepth = prev[t] + horizonMinGapDepth;
        if (line[t] < minDepth) {
          const conf = h.confidence?.[t] || 0;
          if (conf < smoothed.qualityThreshold || smoothed.autoMode === "conservative") {
            line[t] = minDepth;
            repairs++;
          } else {
            line[t] = line[t] * 0.65 + minDepth * 0.35;
            repairs++;
          }
        }
      }
    }
    if (repairs) warnings.push(`${repairs} stratigraphic order repairs`);
    const stats = lineDepthStats(line);
    horizons.push({ ...h, name: `H${i + 1}`, ...stats, warnings, line });
  }
  return { ...smoothed, horizons, horizonMinGapDepth, step: "stratigraphy" };
}

function buildQualityReport(result) {
  const horizons = result.horizons || [];
  const horizonScore = horizons.length ? finiteMean(horizons.map(h => h.meanConfidence || 0)) : 0;
  const coverageScore = horizons.length ? finiteMean(horizons.map(h => (h.coverage || 0) * 100)) : 0;
  const badPenalty = Math.min(20, (result.diagnosis?.badTraceRatio || 0) * 100);
  const score = clamp(0.62 * horizonScore + 0.28 * coverageScore + 10 - badPenalty, 0, 100);
  const lowConfidenceRanges = [];
  for (const h of horizons) {
    let start = -1;
    for (let i = 0; i < h.confidence.length; i++) {
      if (h.confidence[i] < result.confidenceCutoff && start < 0) start = i;
      if ((h.confidence[i] >= result.confidenceCutoff || i === h.confidence.length - 1) && start >= 0) {
        const end = h.confidence[i] >= result.confidenceCutoff ? i - 1 : i;
        if (end - start >= 3) lowConfidenceRanges.push({ horizon: h.name, startTrace: start, endTrace: end });
        start = -1;
      }
    }
  }
  const warnings = [];
  if (!horizons.length) warnings.push("No reliable horizons were found.");
  if (score < result.qualityThreshold) warnings.push("Automatic model should be manually reviewed.");
  if ((result.diagnosis?.badTraceRatio || 0) > 0.08) warnings.push("Bad trace ratio is high.");
  return {
    score,
    threshold: result.qualityThreshold,
    status: score >= result.qualityThreshold ? "pass" : "review",
    horizonCount: horizons.length,
    lowConfidenceRanges,
    warnings,
    diagnosis: result.diagnosis
  };
}

export function geologyClassifyModel(d, nt, ns, params = {}) {
  const strat = geologyEnforceStratigraphy(d, nt, ns, params);
  const modelData = new Uint8Array(strat.modelSamples * nt);
  const uncertaintyData = new Uint8Array(strat.modelSamples * nt);
  const zStep = strat.modelDepthMax / Math.max(1, strat.modelSamples - 1);
  for (let z = 0; z < strat.modelSamples; z++) {
    const depth = z * zStep;
    for (let t = 0; t < nt; t++) {
      let layer = 0, bestConf = 100;
      for (const h of strat.horizons) {
        const hd = h.line[t];
        const conf = h.confidence?.[t] ?? h.meanConfidence ?? 50;
        if (Math.abs(depth - hd) < zStep * 3) bestConf = Math.min(bestConf, conf);
        if (depth >= hd) layer++;
      }
      const idx = z * nt + t;
      modelData[idx] = Math.min(layer, GEO_LABELS.length - 1);
      uncertaintyData[idx] = clamp(Math.round(100 - bestConf), 0, 100);
    }
  }
  const result = {
    ...strat,
    data: strat.processedData || strat.data,
    modelInputData: strat.data,
    modelData,
    uncertaintyData,
    modelTraces: nt,
    modelSamples: strat.modelSamples,
    distanceStep: strat.dx,
    epsilonR: (0.299792458 / strat.velocity) ** 2,
    layerNames: GEO_LABELS,
    boundaryProbability: strat.data,
    step: "classify-model"
  };
  result.qualityReport = buildQualityReport(result);
  return result;
}

export function geologicModel(d, nt, ns, params = {}) {
  return geologyClassifyModel(d, nt, ns, params);
}

export function removeDztGain(d, nt, ns, params = {}) {
  const gainDb = params.gainDb || params.gain || [];
  if (!gainDb.length) return { data: new Float32Array(d), numTraces: nt, numSamples: ns };
  const g = new Float64Array(ns);
  if (gainDb.length === ns) {
    for (let s = 0; s < ns; s++) g[s] = 10 ** (gainDb[s] / 20);
  } else {
    const xs = new Float64Array(gainDb.length);
    const ys = new Float64Array(gainDb.length);
    for (let i = 0; i < gainDb.length; i++) {
      xs[i] = i / Math.max(1, gainDb.length - 1) * (ns - 1);
      ys[i] = gainDb[i];
    }
    for (let s = 0; s < ns; s++) {
      g[s] = 10 ** (linearInterpolate(xs, ys, s) / 20);
    }
  }
  const o = new Float32Array(d.length);
  for (let t = 0; t < nt; t++) {
    for (let s = 0; s < ns; s++) {
      o[t * ns + s] = g[s] > 1e-12 ? d[t * ns + s] / g[s] : d[t * ns + s];
    }
  }
  return { data: o, numTraces: nt, numSamples: ns };
}

export function meanMedianFilter(d, nt, ns, params = {}) {
  const nv = clamp(Math.floor(safeNumber(params.nv ?? params.vSize ?? 3, 3)), 1, Math.floor(ns / 4));
  const nx = clamp(Math.floor(safeNumber(params.nx ?? params.hSize ?? 3, 3)), 1, Math.floor(nt / 4));
  const mode = String(params.mode || "mean").toLowerCase();

  if (mode === "mean" || mode === "meanfilt") {
    const o = new Float32Array(d.length);
    const hv = Math.floor(nv / 2), hx = Math.floor(nx / 2);
    for (let t = 0; t < nt; t++) {
      for (let s = 0; s < ns; s++) {
        let sum = 0, count = 0;
        for (let dt = -hx; dt <= hx; dt++) {
          const tt = Math.max(0, Math.min(nt - 1, t + dt));
          for (let ds = -hv; ds <= hv; ds++) {
            const ss = Math.max(0, Math.min(ns - 1, s + ds));
            sum += d[tt * ns + ss];
            count++;
          }
        }
        o[t * ns + s] = sum / count;
      }
    }
    return { data: o, numTraces: nt, numSamples: ns };
  }

  const o = new Float32Array(d.length);
  const hv = Math.floor(nv / 2), hx = Math.floor(nx / 2);
  const windowVals = new Float64Array(nv * nx);
  for (let t = 0; t < nt; t++) {
    for (let s = 0; s < ns; s++) {
      let wi = 0;
      for (let dt = -hx; dt <= hx; dt++) {
        const tt = Math.max(0, Math.min(nt - 1, t + dt));
        for (let ds = -hv; ds <= hv; ds++) {
          const ss = Math.max(0, Math.min(ns - 1, s + ds));
          windowVals[wi++] = d[tt * ns + ss];
        }
      }
      windowVals.subarray(0, wi).sort();
      o[t * ns + s] = windowVals[Math.floor(wi / 2)];
    }
  }
  return { data: o, numTraces: nt, numSamples: ns };
}

export function notchFilter(d, nt, ns, params = {}) {
  const dtNs = safeNumber(params.dtNs ?? params.dt, 0.625);
  const fNyq = 1 / (2 * dtNs * 1e-3);
  const fNotchMHz = safeNumber(params.frequencyMHz ?? params.fNotchMHz ?? 50, 50);
  const wo = 2 * Math.PI * fNotchMHz / (2 * fNyq);
  const rez = Math.cos(wo), imz = Math.sin(wo);
  const rez1 = 0.99 * rez, imz1 = 0.99 * imz;

  const bR = [1, -2 * rez, rez * rez + imz * imz];
  const aR = [1, -2 * rez1, rez1 * rez1 + imz1 * imz1];

  const nfft = nextPow2(ns);
  const HR = new Float64Array(nfft), HI = new Float64Array(nfft);
  const bRpad = new Float64Array(nfft), bIpad = new Float64Array(nfft);
  const aRpad = new Float64Array(nfft), aIpad = new Float64Array(nfft);
  bRpad.set(bR); aRpad.set(aR);
  fft(bRpad, bIpad); fft(aRpad, aIpad);
  for (let k = 0; k < nfft; k++) {
    const denom = aRpad[k] * aRpad[k] + aIpad[k] * aIpad[k];
    HR[k] = (bRpad[k] * aRpad[k] + bIpad[k] * aIpad[k]) / Math.max(denom, 1e-12);
    HI[k] = (-bRpad[k] * aIpad[k] + bIpad[k] * aRpad[k]) / Math.max(denom, 1e-12);
  }
  let hMax = 0;
  for (let k = 0; k < nfft; k++) hMax = Math.max(hMax, Math.hypot(HR[k], HI[k]));
  if (hMax > 1e-12) for (let k = 0; k < nfft; k++) { HR[k] /= hMax; HI[k] /= hMax; }

  const o = new Float32Array(d.length);
  for (let t = 0; t < nt; t++) {
    const tr = new Float64Array(nfft), ti = new Float64Array(nfft);
    tr.set(d.subarray(t * ns, t * ns + ns));
    fft(tr, ti);
    for (let k = 0; k < nfft; k++) {
      const nr = tr[k] * HR[k] - ti[k] * HI[k];
      const ni = tr[k] * HI[k] + ti[k] * HR[k];
      tr[k] = nr * HR[k] - ni * (-HI[k]);
      ti[k] = nr * (-HI[k]) + ni * HR[k];
    }
    fft(tr, ti, true);
    for (let s = 0; s < ns; s++) o[t * ns + s] = tr[s];
  }
  return { data: o, numTraces: nt, numSamples: ns };
}

export function predictiveDecon(d, nt, ns, params = {}) {
  const dtNs = safeNumber(params.dtNs ?? params.dt, 0.625);
  let nf = clamp(Math.floor(safeNumber(params.operatorLength ?? params.nfSamples ?? 32, 32)), 2, Math.floor(ns / 2) - 1);
  let lp = clamp(Math.floor(safeNumber(params.predictionLength ?? params.lpSamples ?? 1, 1)), 1, nf - 1);
  const mu = clamp(safeNumber(params.muPercent ?? params.mu ?? params.prewhitening ?? 5, 5), 0, 100);

  if (params.operatorLengthNs != null) nf = clamp(Math.floor(safeNumber(params.operatorLengthNs, 32) / dtNs), 2, Math.floor(ns / 2) - 1);
  if (params.predictionLengthNs != null) lp = clamp(Math.floor(safeNumber(params.predictionLengthNs, 1) / dtNs), 1, nf - 1);

  const o = new Float32Array(d.length);
  for (let it = 0; it < nt; it++) {
    const tr = d.subarray(it * ns, it * ns + ns);
    const cc = new Float64Array(nf);
    for (let lag = 0; lag < nf; lag++) {
      let sum = 0;
      for (let i = 0; i < ns - lag; i++) sum += tr[i + lag] * tr[i];
      cc[lag] = sum;
    }

    const R = Array.from({ length: nf }, () => new Float64Array(nf));
    const prewhite = cc[0] * mu / 100;
    for (let i = 0; i < nf; i++) {
      for (let j = 0; j < nf; j++) {
        const lag = Math.abs(i - j);
        R[i][j] = cc[lag] + (i === j ? prewhite : 0);
      }
    }

    const rhs = new Float64Array(nf);
    for (let i = 0; i < nf; i++) rhs[i] = cc[lp + i];

    const f = solveLinearSystem(R, rhs);

    for (let s = 0; s < ns; s++) {
      let pred = tr[s];
      if (lp === 1) {
        for (let k = 0; k < nf && s - k - 1 >= 0; k++) pred -= f[k] * tr[s - k - 1];
      } else {
        for (let k = 0; k < nf && s - k - lp >= 0; k++) pred -= f[k] * tr[s - k - lp];
      }
      o[it * ns + s] = pred;
    }
  }
  return { data: o, numTraces: nt, numSamples: ns, operatorLength: nf, predictionLength: lp };
}

export function staticCorrection(d, nt, ns, params = {}) {
  const dtNs = safeNumber(params.dtNs ?? params.dt, 0.625);
  const wv = clamp(safeNumber(params.wv ?? params.weatheringVelocity ?? 0.1, 0.1), 0.001, 0.2998);
  const swv = clamp(safeNumber(params.swv ?? params.subweatheringVelocity ?? 0.1, 0.1), 0.001, 0.2998);
  const sdel = safeNumber(params.sdel ?? params.datumElevation ?? 0, 0);
  const direction = safeNumber(params.direction ?? params.shiftDirection ?? -1, -1);
  const elevations = params.elevation || params.elevations || params.posZ || [];

  const o = new Float32Array(d.length);
  const tt = new Float64Array(ns);
  for (let s = 0; s < ns; s++) tt[s] = s * dtNs;

  for (let ix = 0; ix < nt; ix++) {
    const relev = Array.isArray(elevations) ? (elevations[ix] ?? elevations[0] ?? 0) : (typeof elevations === "number" ? elevations : 0);
    const selev = relev;
    const tsd = (-selev + sdel) / swv;
    const tstat = tsd;

    for (let s = 0; s < ns; s++) {
      const ts = tt[s] + direction * tstat;
      o[ix * ns + s] = cubicSample(d.subarray(ix * ns, ix * ns + ns), ts / dtNs, 0);
    }
  }
  return { data: o, numTraces: nt, numSamples: ns };
}
