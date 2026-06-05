const EPS0 = 8.8541878176e-12;

export const MATERIAL_PRESETS = [
  { id: "regolith", name: "Regolith", epsr: 9, sigma: 0.0005, mu: 1 },
  { id: "rock", name: "Rock", epsr: 12, sigma: 0.001, mu: 1 },
  { id: "pipe", name: "Metal pipe", epsr: 80, sigma: 1, mu: 1 },
  { id: "void", name: "Void", epsr: 1, sigma: 0, mu: 1 },
  { id: "water", name: "Water bearing", epsr: 36, sigma: 0.03, mu: 1 },
  { id: "custom", name: "Custom", epsr: 9, sigma: 0, mu: 1 }
];

export function calDensity(epsr) {
  const ep = Math.max(Number(epsr) || 1, Number.EPSILON);
  return Math.log(ep) / Math.log(1.93);
}

export function calLossTangent(density) {
  return 10 ** (0.44 * (Number(density) || 0) - 2.943);
}

export function calConductivity(epsr, lossTangent, frequencyHz = 500e6) {
  return 2 * Math.PI * frequencyHz * EPS0 * (Number(epsr) || 1) * (Number(lossTangent) || 0);
}

export function materialFromEpsr(epsr, frequencyHz = 500e6) {
  const density = calDensity(epsr);
  const lossTangent = calLossTangent(density);
  return {
    epsr: Number(epsr) || 1,
    sigma: calConductivity(epsr, lossTangent, frequencyHz),
    mu: 1,
    density,
    lossTangent
  };
}

export function normalizeMaterial(input = {}, fallback = MATERIAL_PRESETS[0]) {
  const base = fallback || MATERIAL_PRESETS[0];
  const preset = MATERIAL_PRESETS.find(m => m.id === input.materialId) || null;
  const src = { ...base, ...(preset || {}), ...input };
  return {
    id: src.id || src.materialId || "custom",
    name: src.name || src.label || "Custom",
    epsr: finitePositive(src.epsr, base.epsr),
    sigma: finiteNonNegative(src.sigma, base.sigma),
    mu: finitePositive(src.mu, base.mu)
  };
}

function finitePositive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function finiteNonNegative(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

