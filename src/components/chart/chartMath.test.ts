import { describe, expect, it } from 'vitest'
import { linearPath, monotonePath, nearestIndex, niceScale, segments } from './chartMath'

describe('niceScale', () => {
  it('rounds auto ends outwards to tidy ticks', () => {
    const s = niceScale(14.2, 31.7)
    expect(s.domain).toEqual([10, 35])
    expect(s.ticks).toEqual([10, 15, 20, 25, 30, 35])
  })
  it('keeps fixed ends', () => {
    expect(niceScale(3, 80, [0, 100]).domain).toEqual([0, 100])
    expect(niceScale(0, 0.37, [0, 'auto']).domain[0]).toBe(0)
  })
  it('handles a flat series and swapped input', () => {
    const flat = niceScale(20, 20)
    expect(flat.domain[0]).toBeLessThan(20)
    expect(flat.domain[1]).toBeGreaterThan(20)
    expect(niceScale(9, 1).domain).toEqual([0, 10])
  })
})

describe('paths', () => {
  it('splits lines at missing values', () => {
    expect(segments([[0, 1], [1, null], [2, 3], [3, 4]])).toEqual([[[0, 1]], [[2, 3], [3, 4]]])
  })
  it('draws straight and smooth paths through the points', () => {
    expect(linearPath([[0, 0], [10, 5]])).toBe('M0.0,0.0L10.0,5.0')
    const d = monotonePath([[0, 0], [10, 10], [20, 10], [30, 0]])
    expect(d.startsWith('M0.0,0.0C')).toBe(true)
    expect(d.endsWith('30.0,0.0')).toBe(true)
  })
  it('never overshoots a flat stretch (monotone)', () => {
    // between two equal points the control points must stay on that level
    const d = monotonePath([[0, 0], [10, 10], [20, 10], [30, 20]])
    const second = d.split('C')[2].split(' ').slice(0, 2).map((p) => Number(p.split(',')[1]))
    expect(second).toEqual([10, 10])
  })
})

describe('nearestIndex', () => {
  it('finds the closest point', () => {
    expect(nearestIndex([0, 10, 20, 30], 14)).toBe(1)
    expect(nearestIndex([0, 10, 20, 30], 16)).toBe(2)
    expect(nearestIndex([0, 10, 20, 30], -5)).toBe(0)
    expect(nearestIndex([], 3)).toBe(-1)
  })
})
