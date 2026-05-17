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
export function spectrum(trace) {
  const n = nextPow2(trace.length), re = new Float64Array(n), im = new Float64Array(n);
  re.set(trace); fft(re, im);
  const out = new Float32Array(n / 2);
  for (let i = 0; i < out.length; i++) out[i] = Math.hypot(re[i], im[i]) / n;
  return out;
}
export function hilbert(trace) {
  const n = nextPow2(trace.length), re = new Float64Array(n), im = new Float64Array(n);
  re.set(trace); fft(re, im);
  for (let i = 1; i < n / 2; i++) { re[i] *= 2; im[i] *= 2; }
  for (let i = Math.floor(n / 2) + 1; i < n; i++) { re[i] = 0; im[i] = 0; }
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
  return { data: o, numTraces: nt, numSamples: nns };
}
export function signalPosition(d, nt, ns, shift = 0) {
  const o = new Float32Array(d.length);
  for (let t = 0; t < nt; t++) for (let s = 0; s < ns; s++) {
    const src = s + shift;
    o[t * ns + s] = src >= 0 && src < ns ? d[t * ns + src] : 0;
  }
  return { data: o, numTraces: nt, numSamples: ns };
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
  const o = new Float32Array(d.length), h = Math.max(1, Math.floor(width / 2));
  for (let t = 0; t < nt; t++) for (let s = 0; s < ns; s++) {
    let sum = 0, c = 0;
    for (let k = t - h; k <= t + h; k++) if (k >= 0 && k < nt) { sum += d[k * ns + s]; c++; }
    const bg = sum / c;
    o[t * ns + s] = mode === "retain" ? bg : d[t * ns + s] - bg;
  }
  return { data: o, numTraces: nt, numSamples: ns };
}
export function agc(d, nt, ns, win = 50, gaussian = false) {
  const o = new Float32Array(d.length), h = Math.max(1, Math.floor(win / 2)), sig = Math.max(1, win / 6);
  for (let t = 0; t < nt; t++) for (let s = 0; s < ns; s++) {
    let sum = 0, c = 0;
    for (let k = s - h; k <= s + h; k++) if (k >= 0 && k < ns) {
      const w = gaussian ? Math.exp(-((k - s) ** 2) / (2 * sig * sig)) : 1;
      sum += d[t * ns + k] ** 2 * w; c += w;
    }
    const rms = Math.sqrt(sum / c);
    o[t * ns + s] = rms > 1e-12 ? d[t * ns + s] / rms : 0;
  }
  return { data: o, numTraces: nt, numSamples: ns };
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
export function powerGain(d, nt, ns, power = 1.5) {
  const o = new Float32Array(d.length);
  for (let s = 0; s < ns; s++) {
    const g = ((s + 1) / ns) ** power * ns ** 0.25;
    for (let t = 0; t < nt; t++) o[t * ns + s] = d[t * ns + s] * g;
  }
  return { data: o, numTraces: nt, numSamples: ns };
}
export function amplitudeGain(d, nt, ns) {
  const att = new Float64Array(ns);
  for (let t = 0; t < nt; t++) {
    const h = hilbert(d.subarray(t * ns, t * ns + ns));
    for (let s = 0; s < ns; s++) att[s] += Math.hypot(h.re[s], h.im[s]);
  }
  for (let s = 0; s < ns; s++) att[s] /= nt;
  const max = Math.max(...att), o = new Float32Array(d.length);
  for (let s = 0; s < ns; s++) {
    const g = att[s] > 1e-9 ? max / att[s] : 1;
    for (let t = 0; t < nt; t++) o[t * ns + s] = d[t * ns + s] * g;
  }
  return { data: o, numTraces: nt, numSamples: ns };
}
export function freqFilter(d, nt, ns, type = "bp", lo = 20e6, hi = 200e6, sampleRate = 1e9) {
  const n = nextPow2(ns), o = new Float32Array(d.length);
  for (let t = 0; t < nt; t++) {
    const re = new Float64Array(n), im = new Float64Array(n); re.set(d.subarray(t * ns, t * ns + ns)); fft(re, im);
    for (let i = 0; i < n; i++) {
      const f = Math.abs((i < n / 2 ? i : i - n) * sampleRate / n);
      const pass = type === "lp" ? f <= hi : type === "hp" ? f >= lo : type === "bs" ? !(f >= lo && f <= hi) : f >= lo && f <= hi;
      if (!pass) { re[i] = 0; im[i] = 0; }
    }
    fft(re, im, true); for (let s = 0; s < ns; s++) o[t * ns + s] = re[s];
  }
  return { data: o, numTraces: nt, numSamples: ns };
}
export function resample(d, nt, ns, axis = "time", newCount = ns) {
  newCount = Math.max(2, Math.floor(newCount));
  if (axis === "scan") {
    const o = new Float32Array(newCount * ns);
    for (let t = 0; t < newCount; t++) {
      const x = t * (nt - 1) / (newCount - 1), i = Math.floor(x), f = x - i;
      for (let s = 0; s < ns; s++) o[t * ns + s] = (d[i * ns + s] || 0) * (1 - f) + (d[Math.min(nt - 1, i + 1) * ns + s] || 0) * f;
    }
    return { data: o, numTraces: newCount, numSamples: ns };
  }
  const o = new Float32Array(nt * newCount);
  for (let t = 0; t < nt; t++) for (let s = 0; s < newCount; s++) {
    const y = s * (ns - 1) / (newCount - 1), i = Math.floor(y), f = y - i;
    o[t * newCount + s] = (d[t * ns + i] || 0) * (1 - f) + (d[t * ns + Math.min(ns - 1, i + 1)] || 0) * f;
  }
  return { data: o, numTraces: nt, numSamples: newCount };
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
export function instantaneous(d, nt, ns, attr = "amplitude") {
  const o = new Float32Array(d.length);
  for (let t = 0; t < nt; t++) {
    const h = hilbert(d.subarray(t * ns, t * ns + ns));
    for (let s = 0; s < ns; s++) {
      const phase = Math.atan2(h.im[s], h.re[s]);
      if (attr === "phase") o[t * ns + s] = phase;
      else if (attr === "frequency" && s > 0) o[t * ns + s] = phase - Math.atan2(h.im[s - 1], h.re[s - 1]);
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
