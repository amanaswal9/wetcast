// Line patterns per model, so lines differ by more than colour.
export const DASHES = ['', '6 3', '2 3', '10 3 2 3', '1 2', '8 2 2 2 2 2']

// A score with fixed decimals, or "n/a" when it is missing.
export function fmt(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a'
}

// How a model's error compares with the baseline, as "12% lower" or "5% higher".
export function improvement(model: number, baseline: number): string {
  if (!Number.isFinite(model) || !Number.isFinite(baseline) || baseline === 0) return 'n/a'
  const pct = ((baseline - model) / baseline) * 100
  return pct >= 0 ? `${pct.toFixed(0)}% lower` : `${Math.abs(pct).toFixed(0)}% higher`
}
