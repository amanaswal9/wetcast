import { afterEach, describe, expect, it, vi } from 'vitest'
import { bandFor, blowingTowards } from '../mapScales'
import { budgetWaitMs, clearGridCache, getGridForecasts, gridFor, nearestPoint, parsePoint, POINTS_PER_MINUTE, pointKey, resetBudget } from './mapGrid'

const NORTH_INDIA = { south: 24, west: 72, north: 32, east: 82 }

function payload(hours = 3) {
  return {
    hourly: {
      time: Array.from({ length: hours }, (_, i) => `2026-11-19T${String(10 + i).padStart(2, '0')}:00`),
      temperature_2m: Array(hours).fill(20),
      precipitation: Array(hours).fill(0),
      wind_speed_10m: Array(hours).fill(12),
      wind_direction_10m: Array(hours).fill(270),
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  clearGridCache()
  resetBudget()
})

const DESKTOP = { width: 700, height: 560 }

describe('grid', () => {
  it('picks the finest spacing that keeps squares readable on screen', () => {
    const grid = gridFor(NORTH_INDIA, DESKTOP)
    expect([grid.latSpacing, grid.lonSpacing]).toEqual([1, 1])
    const close = gridFor({ south: 28, west: 76.5, north: 29, east: 77.5 }, DESKTOP)
    expect([close.latSpacing, close.lonSpacing]).toEqual([0.1, 0.1])
    const phone = gridFor(NORTH_INDIA, { width: 340, height: 320 })
    expect(phone.lonSpacing).toBeGreaterThan(grid.lonSpacing)
  })

  it('places points on multiples of the spacing, covering the view to its edges', () => {
    const grid = gridFor(NORTH_INDIA, DESKTOP)
    expect(grid.points.length).toBe(9 * 11)
    for (const p of grid.points) {
      expect(p.latitude % grid.latSpacing).toBeCloseTo(0)
      expect(p.latitude).toBeGreaterThanOrEqual(24 - grid.latSpacing / 2)
      expect(p.longitude).toBeLessThanOrEqual(82 + grid.lonSpacing / 2)
    }
  })

  it('reuses the same point keys when the view moves a little', () => {
    const a = new Set(gridFor(NORTH_INDIA, DESKTOP).points.map((p) => p.key))
    const b = gridFor({ south: 24.3, west: 72.3, north: 32.3, east: 82.3 }, DESKTOP).points.map((p) => p.key)
    expect(b.filter((k) => a.has(k)).length).toBeGreaterThan(b.length * 0.7)
  })

  it('stays within the point budget and never goes past the poles or the date line', () => {
    const grid = gridFor({ south: -120, west: -400, north: 120, east: 400 }, { width: 2000, height: 1400 })
    expect(grid.points.length).toBeLessThanOrEqual(160)
    for (const p of grid.points) {
      expect(Math.abs(p.latitude)).toBeLessThanOrEqual(84)
      expect(Math.abs(p.longitude)).toBeLessThanOrEqual(180)
    }
  })

  it('finds the nearest point', () => {
    const grid = gridFor(NORTH_INDIA, DESKTOP)
    expect(nearestPoint(grid.points, 28.61, 77.21)?.key).toBe(pointKey(29, 77))
  })
})

describe('fetching', () => {
  it('reads times as UTC and checks column lengths', () => {
    const f = parsePoint(payload())
    expect(f.times[0]).toBe(Date.UTC(2026, 10, 19, 10))
    const broken = payload()
    broken.hourly.temperature_2m.pop()
    expect(() => parsePoint(broken)).toThrow()
  })

  it('fetches only points that are not cached', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const n = new URL(url).searchParams.get('latitude')!.split(',').length
      return new Response(JSON.stringify(n === 1 ? payload() : Array.from({ length: n }, () => payload())))
    })
    vi.stubGlobal('fetch', fetchMock)
    const points = gridFor({ south: 28, west: 76, north: 29, east: 77 }).points
    const first = await getGridForecasts(points)
    expect(first.size).toBe(points.length)
    expect(fetchMock).toHaveBeenCalledTimes(Math.ceil(points.length / 100)) // at most 100 locations per request
    const callsBefore = fetchMock.mock.calls.length
    const moved = gridFor({ south: 28, west: 76, north: 29, east: 77.1 }).points
    await getGridForecasts(moved)
    const later = fetchMock.mock.calls.slice(callsBefore).flatMap(([url]) => new URL(url).searchParams.get('latitude')!.split(','))
    expect(later.length).toBe(moved.length - points.length)
  })
})

describe('request budget', () => {
  it('waits instead of going over the per-minute limit', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      const n = new URL(url).searchParams.get('latitude')!.split(',').length
      return new Response(JSON.stringify(n === 1 ? payload() : Array.from({ length: n }, () => payload())))
    })
    const points = gridFor({ south: 28, west: 76, north: 29, east: 77 }).points
    await getGridForecasts(points)
    const used = points.length
    expect(budgetWaitMs(POINTS_PER_MINUTE - used)).toBe(0)
    expect(budgetWaitMs(POINTS_PER_MINUTE - used + 1)).toBeGreaterThan(55_000)
    expect(budgetWaitMs(1, Date.now() + 61_000)).toBe(0)
  })

  it('explains a rate limit in plain words', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ reason: 'Minutely API request limit exceeded' }), { status: 429 }))
    await expect(getGridForecasts(gridFor(NORTH_INDIA).points)).rejects.toThrow(/free limit/)
  })
})

describe('scales', () => {
  it('maps values to bands', () => {
    expect(bandFor('temperature', 22)?.label).toBe('20 to 25')
    expect(bandFor('temperature', -40)?.label).toBe('below −20')
    expect(bandFor('rain', 0)).toBeNull()
    expect(bandFor('rain', 3)?.label).toBe('2 to 5')
    expect(bandFor('wind', null)).toBeNull()
  })

  it('turns "wind from" into "blowing towards"', () => {
    expect(blowingTowards(0)).toBe(180)
    expect(blowingTowards(270)).toBe(90)
  })
})
