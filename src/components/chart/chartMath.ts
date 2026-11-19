/** Small, dependency-free maths for the SVG charts: nice axis ticks and smooth paths. */

export type Num = number | null | undefined

export function isNum(v: Num): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function niceStep(rough: number): number {
  const power = 10 ** Math.floor(Math.log10(rough))
  const f = rough / power
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * power
}

/**
 * A rounded domain and evenly spaced tick values covering [min, max].
 * `fixed` ends are kept as given (e.g. 0 for rain or 100 for humidity); 'auto' ends are
 * rounded outwards to a tick, like most charting libraries do.
 */
export function niceScale(
  min: number,
  max: number,
  ends: [number | 'auto', number | 'auto'] = ['auto', 'auto'],
  count = 5,
): { domain: [number, number]; ticks: number[] } {
  let lo = ends[0] === 'auto' ? min : ends[0]
  let hi = ends[1] === 'auto' ? max : ends[1]
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0
    hi = 1
  }
  if (hi < lo) [lo, hi] = [hi, lo]
  if (hi === lo) {
    const pad = Math.abs(lo) > 1 ? Math.abs(lo) * 0.1 : 1
    if (ends[0] === 'auto') lo -= pad
    if (ends[1] === 'auto') hi += pad
    if (hi === lo) hi = lo + 1
  }
  const step = niceStep((hi - lo) / Math.max(count - 1, 1))
  const d0 = ends[0] === 'auto' ? Math.floor(lo / step) * step : lo
  const d1 = ends[1] === 'auto' ? Math.ceil(hi / step) * step : hi
  const ticks: number[] = []
  for (let t = Math.ceil(d0 / step) * step; t <= d1 + step * 1e-9; t += step) {
    ticks.push(Math.round(t / step) * step)
  }
  return { domain: [d0, d1], ticks }
}

/** Runs of consecutive defined points; a missing value breaks a line. */
export function segments(points: [number, Num][]): [number, number][][] {
  const out: [number, number][][] = []
  let run: [number, number][] = []
  for (const [x, y] of points) {
    if (isNum(y)) run.push([x, y])
    else if (run.length) {
      out.push(run)
      run = []
    }
  }
  if (run.length) out.push(run)
  return out
}

/** SVG path through points with straight segments. */
export function linearPath(pts: [number, number][]): string {
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('')
}

/**
 * Smooth path that never overshoots the data (monotone cubic interpolation, the
 * Fritsch-Carlson method; the same idea as d3's curveMonotoneX). Points must be in
 * increasing x order.
 */
export function monotonePath(pts: [number, number][]): string {
  const n = pts.length
  if (n < 3) return linearPath(pts)
  const dx: number[] = []
  const m: number[] = []
  for (let k = 0; k < n - 1; k++) {
    dx.push(pts[k + 1][0] - pts[k][0])
    m.push(dx[k] === 0 ? 0 : (pts[k + 1][1] - pts[k][1]) / dx[k])
  }
  const t: number[] = [m[0]]
  for (let k = 1; k < n - 1; k++) t.push(m[k - 1] * m[k] <= 0 ? 0 : (m[k - 1] + m[k]) / 2)
  t.push(m[n - 2])
  for (let k = 0; k < n - 1; k++) {
    if (m[k] === 0) {
      t[k] = 0
      t[k + 1] = 0
      continue
    }
    const a = t[k] / m[k]
    const b = t[k + 1] / m[k]
    const s = a * a + b * b
    if (s > 9) {
      const tau = 3 / Math.sqrt(s)
      t[k] = tau * a * m[k]
      t[k + 1] = tau * b * m[k]
    }
  }
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`
  for (let k = 0; k < n - 1; k++) {
    const h = dx[k] / 3
    const [x0, y0] = pts[k]
    const [x1, y1] = pts[k + 1]
    d += `C${(x0 + h).toFixed(1)},${(y0 + t[k] * h).toFixed(1)} ${(x1 - h).toFixed(1)},${(y1 - t[k + 1] * h).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`
  }
  return d
}

/** Index of the point whose x is closest to `x` (xs sorted ascending). */
export function nearestIndex(xs: number[], x: number): number {
  if (!xs.length) return -1
  let lo = 0
  let hi = xs.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (xs[mid] < x) lo = mid
    else hi = mid
  }
  return Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x) ? lo : hi
}
