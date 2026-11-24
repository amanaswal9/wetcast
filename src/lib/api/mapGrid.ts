// Weather-map grid: Open-Meteo forecasts at evenly spaced points over the visible map.
//
// Each point is Open-Meteo's forecast for that exact spot (model data, not a
// measurement). Points sit on multiples of the grid spacing, so panning reuses
// points already fetched and only the new ones are requested.
import { ApiError, fetchJson } from './http'
import { arr, numOrNull, obj, str } from './validate'

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const VARS = ['temperature_2m', 'precipitation', 'wind_speed_10m', 'wind_direction_10m'] as const
// Hours ahead the map's slider covers.
export const MAP_HOURS = 48
// Open-Meteo counts every location as one call, so keep views modest.
const MAX_POINTS = 160
const CHUNK = 100
const TTL_MS = 30 * 60_000
// Smallest square on screen, in pixels, so the grid stays readable.
const MIN_CELL_PX = 40
// Open-Meteo's free tier allows 600 calls a minute per visitor, shared with the rest of
// the app. The map keeps itself to this many points in any rolling minute and waits
// rather than hitting the limit.
export const POINTS_PER_MINUTE = 400

// Grid spacings in degrees, finest first.
export const SPACINGS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20] as const

export interface Bounds {
  south: number
  west: number
  north: number
  east: number
}

// The map's size on screen, in pixels.
export interface ViewSize {
  width: number
  height: number
}

export interface GridPoint {
  key: string
  latitude: number
  longitude: number
}

export interface PointForecast {
  // UTC times, one per hour.
  times: number[]
  temperature: (number | null)[]
  precipitation: (number | null)[]
  windSpeed: (number | null)[]
  windDirection: (number | null)[]
}

export interface Grid {
  latSpacing: number
  lonSpacing: number
  points: GridPoint[]
}

const LAT_LIMIT = 84

// Keeps a latitude inside the band the map draws.
function clampLat(value: number): number {
  return Math.min(Math.max(value, -LAT_LIMIT), LAT_LIMIT)
}

// Keeps a longitude between -180 and 180.
function clampLon(value: number): number {
  return Math.min(Math.max(value, -180), 180)
}

// Grid indices whose points lie within [lo, hi] widened by half a cell, so squares reach the map's edges.
function indexRange(lo: number, hi: number, spacing: number, clamp: (v: number) => number): [number, number] {
  return [Math.ceil(clamp(lo - spacing / 2) / spacing - 1e-9), Math.floor(clamp(hi + spacing / 2) / spacing + 1e-9)]
}

// How many grid points an index range holds.
function count(range: [number, number]): number {
  return Math.max(0, range[1] - range[0] + 1)
}

// Finest spacing that fits at most `maxCount` points across the span.
function pickSpacing(lo: number, hi: number, maxCount: number, clamp: (v: number) => number): number {
  for (const s of SPACINGS) if (count(indexRange(lo, hi, s, clamp)) <= maxCount) return s
  return SPACINGS[SPACINGS.length - 1]
}

// The next wider grid spacing, or the widest when already there.
function coarser(spacing: number): number {
  const i = SPACINGS.indexOf(spacing as (typeof SPACINGS)[number])
  return SPACINGS[Math.min(i + 1, SPACINGS.length - 1)]
}

// Three decimal places (about 100 m), so the same point always gives the same key.
function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

// Cache key for a grid point, rounded so floating-point noise doesn't split entries.
export function pointKey(latitude: number, longitude: number): string {
  return `${round(latitude).toFixed(3)},${round(longitude).toFixed(3)}`
}

// Grid points covering the view, on multiples of the spacings. Each axis gets the
// finest spacing that keeps squares at least MIN_CELL_PX on screen; the total is
// capped at MAX_POINTS by coarsening the finer axis.
export function gridFor(bounds: Bounds, size: ViewSize = { width: 720, height: 400 }): Grid {
  const { south, north, west, east } = bounds
  const maxCols = Math.max(3, Math.floor(size.width / MIN_CELL_PX))
  const maxRows = Math.max(3, Math.floor(size.height / MIN_CELL_PX))
  let lonSpacing = pickSpacing(west, east, maxCols, clampLon)
  let latSpacing = pickSpacing(south, north, maxRows, clampLat)
  const total = () => count(indexRange(south, north, latSpacing, clampLat)) * count(indexRange(west, east, lonSpacing, clampLon))
  while (total() > MAX_POINTS && (lonSpacing !== coarser(lonSpacing) || latSpacing !== coarser(latSpacing))) {
    if (lonSpacing <= latSpacing && lonSpacing !== coarser(lonSpacing)) lonSpacing = coarser(lonSpacing)
    else latSpacing = coarser(latSpacing)
  }
  const [lat0, lat1] = indexRange(south, north, latSpacing, clampLat)
  const [lon0, lon1] = indexRange(west, east, lonSpacing, clampLon)
  const points: GridPoint[] = []
  for (let i = lat1; i >= lat0; i--) {
    for (let j = lon0; j <= lon1; j++) {
      const latitude = round(i * latSpacing)
      const longitude = round(j * lonSpacing)
      points.push({ key: pointKey(latitude, longitude), latitude, longitude })
    }
  }
  return { latSpacing, lonSpacing, points: points.slice(0, MAX_POINTS) }
}

// The grid point closest to a position (by degrees, which is fine at this scale).
export function nearestPoint(points: GridPoint[], latitude: number, longitude: number): GridPoint | null {
  let best: GridPoint | null = null
  let bestD = Infinity
  for (const p of points) {
    const d = Math.hypot(p.latitude - latitude, p.longitude - longitude)
    if (d < bestD) {
      bestD = d
      best = p
    }
  }
  return best
}

// Read one location from an Open-Meteo multi-location response.
export function parsePoint(raw: unknown): PointForecast {
  const hourly = obj(obj(raw, 'location').hourly, 'hourly')
  const times = arr(hourly.time, 'hourly.time').map((t) => Date.parse(`${str(t, 'time')}Z`))
  const column = (name: string) => {
    const values = arr(hourly[name], name).map((v) => numOrNull(v))
    if (values.length !== times.length) throw new ApiError('invalid', 'The weather service sent an unexpected answer for the map.')
    return values
  }
  return {
    times,
    temperature: column('temperature_2m'),
    precipitation: column('precipitation'),
    windSpeed: column('wind_speed_10m'),
    windDirection: column('wind_direction_10m'),
  }
}

const pointCache = new Map<string, { expires: number; forecast: PointForecast }>()

// Points with no fresh cached forecast.
export function uncachedPoints(points: GridPoint[]): GridPoint[] {
  const now = Date.now()
  return points.filter((p) => !((pointCache.get(p.key)?.expires ?? 0) > now))
}

// Points requested recently, for the per-minute budget.
const spent: { at: number; points: number }[] = []

// How long to wait before `points` more fit in the rolling one-minute budget.
export function budgetWaitMs(points: number, now = Date.now()): number {
  while (spent.length && spent[0].at <= now - 60_000) spent.shift()
  let used = spent.reduce((sum, s) => sum + s.points, 0)
  if (used + points <= POINTS_PER_MINUTE) return 0
  for (const s of spent) {
    used -= s.points
    if (used + points <= POINTS_PER_MINUTE) return s.at + 60_000 - now + 50
  }
  return 60_000
}

// Waits when Open-Meteo's request budget is used up, unless the request is cancelled first.
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Request cancelled', 'AbortError'))
      },
      { once: true },
    )
  })
}

// Forget cached points (used by the Refresh button and tests).
export function clearGridCache(): void {
  pointCache.clear()
}

// Reset the per-minute budget (tests only).
export function resetBudget(): void {
  spent.length = 0
}

// Forecasts for every point, fetching only those not cached. Missing points are
// fetched in batches of up to 100 locations per request.
export async function getGridForecasts(
  points: GridPoint[],
  options: { signal?: AbortSignal; fresh?: boolean; onWait?: (ms: number) => void; onProgress?: (done: number, total: number) => void } = {},
): Promise<Map<string, PointForecast>> {
  const now = Date.now()
  const out = new Map<string, PointForecast>()
  const missing: GridPoint[] = []
  for (const p of points) {
    const hit = pointCache.get(p.key)
    if (!options.fresh && hit && hit.expires > now) out.set(p.key, hit.forecast)
    else missing.push(p)
  }
  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunk = missing.slice(i, i + CHUNK)
    const wait = budgetWaitMs(chunk.length)
    if (wait > 0) {
      options.onWait?.(wait)
      await sleep(wait, options.signal)
    }
    spent.push({ at: Date.now(), points: chunk.length })
    const params = new URLSearchParams({
      latitude: chunk.map((p) => p.latitude.toFixed(3)).join(','),
      longitude: chunk.map((p) => p.longitude.toFixed(3)).join(','),
      hourly: VARS.join(','),
      forecast_hours: String(MAP_HOURS),
      timezone: 'GMT',
    })
    let body: unknown
    try {
      body = await fetchJson(`${FORECAST_URL}?${params}`, { signal: options.signal, timeoutMs: 20_000 })
    } catch (error) {
      if (error instanceof ApiError && error.status === 429) {
        throw new ApiError('http', "Open-Meteo's free limit for this minute (or day) has been reached. Wait a minute, then try again.", 429)
      }
      throw error
    }
    const items = Array.isArray(body) ? body : [body]
    if (items.length !== chunk.length) throw new ApiError('invalid', 'The weather service sent an unexpected answer for the map.')
    chunk.forEach((p, k) => {
      const forecast = parsePoint(items[k])
      pointCache.set(p.key, { expires: now + TTL_MS, forecast })
      out.set(p.key, forecast)
    })
    options.onProgress?.(Math.min(i + CHUNK, missing.length), missing.length)
  }
  return out
}
