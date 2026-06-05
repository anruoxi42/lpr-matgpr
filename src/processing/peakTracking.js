export function isLocalMax(trace, index) {
  if (!trace || index <= 0 || index >= trace.length - 1) return false;
  const v = trace[index];
  return Number.isFinite(v) && v > trace[index - 1] && v >= trace[index + 1];
}

export function localMaxima(trace, start = 0, end = trace.length - 1) {
  const peaks = [];
  const lo = Math.max(1, Math.floor(start));
  const hi = Math.min(trace.length - 2, Math.floor(end));
  for (let i = lo; i <= hi; i++) if (isLocalMax(trace, i)) peaks.push(i);
  return peaks;
}

export function pickPeaksNearPoint(data, numTraces, numSamples, point, options = {}) {
  const radius = Math.max(0, Math.round(Number(options.radius) || 0));
  const startSample = Math.max(0, Math.round(Number(options.startSample ?? 0)));
  const endSample = Math.min(numSamples - 1, Math.round(Number(options.endSample ?? numSamples - 1)));
  const trace = Math.round(point.traceIndex ?? point.x ?? 0);
  const sample = Math.round(point.sampleIndex ?? point.y ?? 0);
  const picks = [];
  for (let t = Math.max(0, trace - radius); t <= Math.min(numTraces - 1, trace + radius); t++) {
    const line = options.invert ? invertedTrace(data, t, numSamples) : data.subarray(t * numSamples, t * numSamples + numSamples);
    const peaks = localMaxima(line, startSample, endSample);
    if (!peaks.length) continue;
    let bestS = peaks[0], bestDist = Infinity, bestAmp = -Infinity;
    for (const s of peaks) {
      const dist = Math.abs(s - sample);
      const amp = line[s];
      if (dist < bestDist || (dist === bestDist && amp > bestAmp)) {
        bestDist = dist;
        bestAmp = amp;
        bestS = s;
      }
    }
    picks.push({ traceIndex: t, sampleIndex: bestS, amplitude: line[bestS], distance: bestDist });
  }
  picks.sort((a, b) => a.traceIndex - b.traceIndex);
  return picks;
}

function invertedTrace(data, traceIndex, numSamples) {
  const out = new Float32Array(numSamples);
  const offset = traceIndex * numSamples;
  for (let s = 0; s < numSamples; s++) out[s] = -data[offset + s];
  return out;
}

export function mergePickedPoints(existing = [], picks = []) {
  const byTrace = new Map(existing.map(p => [p.traceIndex, { ...p }]));
  for (const p of picks) byTrace.set(p.traceIndex, { ...byTrace.get(p.traceIndex), ...p });
  return Array.from(byTrace.values()).sort((a, b) => a.traceIndex - b.traceIndex);
}

export function snapPointToPeak(data, numTraces, numSamples, point, options = {}) {
  const picks = pickPeaksNearPoint(data, numTraces, numSamples, point, { ...options, radius: 0 });
  return picks[0] || { ...point, amplitude: data[Math.round(point.traceIndex) * numSamples + Math.round(point.sampleIndex)] || 0 };
}

export function traceFromSeed(data, numTraces, numSamples, seed, options = {}) {
  const halfWindow = Math.max(1, Math.round(Number(options.halfWindowSamples) || 8));
  const directionPenalty = Number(options.directionPenalty ?? 0.08);
  const startSample = Math.max(0, Math.round(Number(options.startSample ?? 0)));
  const endSample = Math.min(numSamples - 1, Math.round(Number(options.endSample ?? numSamples - 1)));
  const points = [];
  for (const dir of [-1, 1]) {
    let sample = Math.max(startSample, Math.min(endSample, Math.round(seed.sampleIndex)));
    const part = [];
    for (let t = Math.round(seed.traceIndex); t >= 0 && t < numTraces; t += dir) {
      let bestS = sample, best = -Infinity;
      const lo = Math.max(startSample, sample - halfWindow);
      const hi = Math.min(endSample, sample + halfWindow);
      for (let s = lo; s <= hi; s++) {
        const v = data[t * numSamples + s] - Math.abs(s - sample) / halfWindow * directionPenalty;
        if (v > best) {
          best = v;
          bestS = s;
        }
      }
      sample = bestS;
      part.push({ traceIndex: t, sampleIndex: bestS, amplitude: data[t * numSamples + bestS], snapScore: best });
    }
    if (dir < 0) points.push(...part.reverse());
    else points.push(...part.slice(1));
  }
  return points;
}
