// Client for Wetcast's own FastAPI backend (/api, proxied by Vite in dev).
// Every number here comes from trained models and real evaluation runs.
import { log } from '../log'
import { HAS_PUBLIC_DATA, HAS_SERVER, NO_SERVER_MESSAGE, sitePath } from '../site'
import { ApiError } from './http'

export type Target = 'temperature' | 'humidity' | 'precipitation'

export interface CoveredCity {
  id: string
  name: string
  latitude: number
  longitude: number
  // 'train': the models trained on it; 'holdout': kept out of training to test them on new places.
  role?: 'train' | 'holdout' | null
}

// What kind of place a forecast is for, and the accuracy measured for that kind of place.
export interface PredictionCoverage {
  kind: 'trained' | 'held_out' | 'untrained'
  label: string
  detail: string
  nearest_city: CoveredCity
  nearest_km: number
  // The model whose measured accuracy is given (the ensemble when it is served).
  model: string
  expected_error: {
    mae: Record<Target, number | null>
    basis: string
    // Lowest and highest temperature error among the held-out cities (untrained places only).
    temperature_range: [number, number] | null
  }
}

export interface ModelPoint {
  time: string
  lead_hours: number
  temperature: number
  temperature_lower: number
  temperature_upper: number
  humidity: number
  humidity_lower: number
  humidity_upper: number
  precipitation: number
  precipitation_lower: number
  precipitation_upper: number
  // Chance (0-1) of at least 0.1 mm of rain in the hour; only the ensemble has one.
  rain_chance?: number | null
}

export interface ModelPrediction {
  model: string
  display_name: string
  points: ModelPoint[]
}

// Wetcast's own rain warning for the 24 forecast hours, from the Ensemble (not an official warning).
// "rain": 2.5 mm or more likely; "moderate": 15.6 mm or more possible. The two shares are its record
// on the 2026 test period: warnings followed by that much rain, and times that much fell that were warned of.
export interface RainWarning {
  level: 'rain' | 'moderate'
  event_mm: number
  wet_hours: number
  total_mm: number
  peak_time: string
  until: string
  followed_by_rain: number | null
  caught: number | null
}

export interface Predictions {
  city: CoveredCity
  issued_at: string
  interval_level: number
  source: string
  note: string
  coverage: PredictionCoverage
  models: ModelPrediction[]
  // Missing from forecasts published before warnings existed.
  rain_warning?: RainWarning | null
}

export type PredictionsResult = { kind: 'ok'; data: Predictions } | { kind: 'unsupported'; supported: CoveredCity[]; detail: string }

export interface MetricSummary {
  mae: number
  rmse: number
  r2: number
  n: number
  unit: string
}

export interface ModelMetrics {
  model: string
  display_name: string
  test: Record<Target, MetricSummary>
  persistence_baseline: Record<Target, MetricSummary>
  // Same test period, at the held-out cities the models never trained on (all-India models only).
  test_unseen?: Record<Target, MetricSummary>
  persistence_baseline_unseen?: Record<Target, MetricSummary>
  interval: {
    level: number
    method: string
    halfwidth_by_horizon: Record<Target, number[]>
    // Half-widths per calendar month (12 rows) and lead hour; older models have one set for the year.
    halfwidth_by_month?: Record<Target, number[][]>
    test_coverage: Record<Target, number>
    // Same check at the held-out cities (all-India models only).
    test_coverage_unseen?: Record<Target, number>
  }
  // The ensemble's rain-amount correction (expected amounts) and its test scores before it.
  rain_amount?: { trees: number; test_before: MetricSummary; test_unseen_before?: MetricSummary | null }
  // The ensemble's chance-of-rain scores (Brier score, lower is better), when it has a table.
  rain_chance?: {
    wet_mm: number
    validation_rain_share: number
    // Present when a LightGBM classifier (with Open-Meteo's day-old forecast as an input) gives the chance.
    model?: { outlook: boolean; trees: number }
    scores: {
      test: { brier: number; climatology_brier: number; rain_share: number; isotonic_brier?: number; without_forecast_brier?: number }
      test_unseen?: { brier: number; climatology_brier: number; rain_share: number }
      reliability_test: { said: number; rained: number; n: number }[]
    }
  }
  inference: { single_ms_median: number; batch256_ms_per_forecast: number; device: string; cpu: string }
  windows: { val: number; test: number }
  trained_at: string
  parameters: number
  config?: {
    lookback_hours: number
    target_mode: 'direct' | 'residual24'
    loss: 'mse' | 'huber'
    train_stride_hours: number
    // Transformer settings (patch hours, token width, blocks, heads, dropout).
    architecture?: { patch: number; dim: number; layers: number; heads: number; dropout: number }
  }
  framework: { tensorflow: string; keras: string }
  training: {
    epochs_run: number | null
    best_epoch: number | null
    best_val_loss: number | null
    seconds: number
    train_windows?: number
    train_stride_hours?: number
    note?: string
  }
  // "ensemble" averages other models; "gbm" is LightGBM (trees, no epochs); "linear" is the Ridge baseline.
  kind?: 'ensemble' | 'gbm' | 'linear'
  members?: string[]
  method?: string
  trees?: Record<Target, number>
  feature_importance?: Record<Target, { feature: string; share: number }[]>
  member_selection?: { rule: string; candidates: { members: string[]; validation_score: number }[] }
  data: {
    source: string
    region: string
    cities: (CoveredCity & { elevation_m: number })[]
    splits: Record<'train' | 'val' | 'test', [string, string]>
    lookback_hours: number
    horizon_hours: number
    n_features: number
    targets: Target[]
  }
}

export interface Evaluation {
  model: string
  per_horizon_mae: Record<Target, number[]>
  per_city_mae: Record<Target, Record<string, number>>
  samples?: Record<string, Record<string, (string | number | null)[]>>
}

// Thrown when there is no Wetcast server to ask or it can't be reached.
class BackendUnavailable extends ApiError {}

// On a public copy with exported data, the file that holds what this API address would answer
// (backend/scripts/export_public_data.py writes them), or null when the answer needs the server.
export function publicDataFile(path: string): string | null {
  const url = new URL(path, 'http://x')
  if (url.pathname === '/api/models') return 'data/models.json'
  if (url.pathname === '/api/coverage') return 'data/coverage.json'
  // The server takes a point; the public copy's forecasts are per city, asked for as ?city=<id>.
  if (url.pathname === '/api/predictions') {
    const city = url.searchParams.get('city')
    return city && /^[a-z_]+$/.test(city) ? `data/predictions/${city}.json` : null
  }
  const evaluation = /^\/api\/models\/([a-z_]+)\/evaluation$/.exec(url.pathname)
  if (evaluation) {
    const city = url.searchParams.get('city')
    if (city) return /^[a-z_]+$/.test(city) ? `data/evaluation/${evaluation[1]}/${city}.json` : null
    return url.searchParams.get('include_samples') === 'false' ? `data/evaluation/${evaluation[1]}.json` : null
  }
  return null
}

// Calls the Wetcast API with a timeout; a missing or unreachable server becomes a clear message.
async function getJson(
  path: string,
  signal?: AbortSignal,
  init: RequestInit = {},
  timeoutMs = 20_000,
): Promise<{ status: number; body: unknown }> {
  if (!HAS_SERVER) {
    // The public copy has no server to ask: read the exported file if there is one, and don't send
    // requests that can only fail.
    const file = HAS_PUBLIC_DATA && (init.method ?? 'GET') === 'GET' ? publicDataFile(path) : null
    if (!file) throw new BackendUnavailable('no-server', NO_SERVER_MESSAGE)
    path = sitePath(file)
  }
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  // Passes the caller's abort on to this request.
  const forward = () => controller.abort()
  signal?.addEventListener('abort', forward, { once: true })
  try {
    const res = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
    })
    const text = await res.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      // Vite returns HTML when the backend isn't running; treat as unavailable below.
    }
    if (body === null && !res.ok) throw new BackendUnavailable('network', "Wetcast's prediction service isn't reachable.")
    return { status: res.status, body }
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError')
    log.warn('backend request failed', path, error)
    throw new BackendUnavailable('network', "Wetcast's prediction service isn't reachable.")
  } finally {
    window.clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}

// The API's own error message when it sent one, else the fallback.
function detailOf(body: unknown, fallback: string): string {
  return body && typeof body === 'object' && 'detail' in body && typeof body.detail === 'string' ? body.detail : fallback
}

const PREDICTIONS_TTL_MS = 10 * 60_000
const predictionsCache = new Map<string, { expires: number; promise: Promise<PredictionsResult> }>()

// Resolve with `promise`, or reject with an AbortError as soon as `signal` aborts (the request itself carries on).
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new DOMException('Request cancelled', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('Request cancelled', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

// Wetcast's predictions for a point. Answers are kept for 10 minutes (the models only
// change their forecast once an hour), and simultaneous requests for the same point,
// such as a background prefetch and the Forecast page, share one network request.
export function getPredictions(
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
  fresh = false,
  // Two-letter country code when the place came from search; the server decides from the map otherwise.
  country?: string,
): Promise<PredictionsResult> {
  const key = `${latitude.toFixed(3)},${longitude.toFixed(3)}:${country ?? ''}`
  let hit = predictionsCache.get(key)
  if (fresh || !hit || hit.expires < Date.now()) {
    const entry = { expires: Date.now() + PREDICTIONS_TTL_MS, promise: fetchPredictions(latitude, longitude, country) }
    entry.promise.catch(() => {
      if (predictionsCache.get(key) === entry) predictionsCache.delete(key) // never keep a failure
    })
    predictionsCache.set(key, entry)
    hit = entry
  }
  return untilAborted(hit.promise, signal)
}

// Great-circle distance in km, as the server measures it (weatherai_ml.predict.haversine_km).
function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180
  const dLat = Math.sin(((lat2 - lat1) * rad) / 2)
  const dLon = Math.sin(((lon2 - lon1) * rad) / 2)
  const a = dLat * dLat + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * dLon * dLon
  return 2 * 6371 * Math.asin(Math.sqrt(a))
}

// A point this close to one of the models' cities gets that city's forecast (the server's CITY_KM).
const CITY_KM = 30

let moreCities: Promise<CoveredCity[]> | null = null

// The public copy's extra cities: forecast like any place in India, never trained on (data/more_cities.json).
// A copy published before the list existed has no file, which means none; so has the full setup, whose
// server forecasts anywhere in India near the cities.
export function getMoreCities(): Promise<CoveredCity[]> {
  if (!HAS_PUBLIC_DATA) return Promise.resolve([])
  moreCities ??= fetch(sitePath('data/more_cities.json'), { headers: { Accept: 'application/json' } })
    .then((res) => (res.ok ? res.json() : []))
    .then((body: unknown) => (Array.isArray(body) ? (body as CoveredCity[]) : []))
    .catch(() => {
      moreCities = null // try again next time
      return []
    })
  return moreCities
}

// The public copy's forecasts: the exported file for the city at this point. The server also
// forecasts anywhere in India near the cities; without it, other places get the list of cities.
async function publicPredictions(latitude: number, longitude: number): Promise<PredictionsResult> {
  const [covered, more] = await Promise.all([getCoverage(), getMoreCities()])
  const nearby = [...covered, ...more]
    .map((city) => ({ city, km: distanceKm(latitude, longitude, city.latitude, city.longitude) }))
    .sort((a, b) => a.km - b.km)
  if (!nearby.length || nearby[0].km > CITY_KM) {
    return {
      kind: 'unsupported',
      supported: nearby.map((n) => n.city),
      detail: `On this public copy, Wetcast's own models forecast for the ${nearby.length} cities below, updated every 3 hours. The full setup also covers the rest of India near them.`,
    }
  }
  const { status, body } = await getJson(`/api/predictions?city=${encodeURIComponent(nearby[0].city.id)}`)
  if (status !== 200) throw new ApiError('http', `The latest update has no forecast for ${nearby[0].city.name}. Try again later.`, status)
  return { kind: 'ok', data: body as Predictions }
}

// Asks the API for Wetcast's forecasts for a point; outside the models' coverage it returns the covered cities instead.
async function fetchPredictions(latitude: number, longitude: number, country?: string): Promise<PredictionsResult> {
  if (HAS_PUBLIC_DATA) return publicPredictions(latitude, longitude)
  const params = new URLSearchParams({ latitude: latitude.toFixed(4), longitude: longitude.toFixed(4) })
  if (country && /^[A-Za-z]{2}$/.test(country)) params.set('country', country.toUpperCase())
  const { status, body } = await getJson(`/api/predictions?${params}`)
  if (status === 404 && body && typeof body === 'object' && 'code' in body && body.code === 'unsupported_location') {
    const b = body as unknown as { supported: CoveredCity[]; detail: string }
    return { kind: 'unsupported', supported: b.supported, detail: b.detail }
  }
  if (status !== 200) throw new ApiError('http', detailOf(body, `The prediction service returned an error (${status}).`), status)
  return { kind: 'ok', data: body as Predictions }
}

// Every trained model with its test scores.
export async function getModels(signal?: AbortSignal): Promise<ModelMetrics[]> {
  const { status, body } = await getJson('/api/models', signal)
  if (status !== 200) throw new ApiError('http', detailOf(body, `The model service returned an error (${status}).`), status)
  return (body as { models: ModelMetrics[] }).models
}

// Detailed evaluation for one model. Samples for a city are included only when asked for.
export async function getEvaluation(model: string, options: { samplesFor?: string } = {}, signal?: AbortSignal): Promise<Evaluation> {
  const params = new URLSearchParams(options.samplesFor ? { city: options.samplesFor } : { include_samples: 'false' })
  const { status, body } = await getJson(`/api/models/${encodeURIComponent(model)}/evaluation?${params}`, signal)
  if (status !== 200) throw new ApiError('http', detailOf(body, `The model service returned an error (${status}).`), status)
  return body as Evaluation
}

// One group of scored forecast hours from the live track record.
export interface TrackStats {
  model: string
  target: Target
  n: number
  mae: number
  persistence_mae: number
  coverage: number
}

export interface TrackRecord {
  days: number
  city: string | null
  // Which model set the record is for ("india", "north_india"); older sets aren't mixed in.
  model_set?: string
  first_valid_at: string | null
  last_valid_at: string | null
  runs: number
  cities: number
  pending_points: number
  settle_hours: number
  // How often the server issues and scores forecasts; 0 when the job is off.
  interval_hours: number
  models: { model: string; display_name: string }[]
  totals: TrackStats[]
  daily: (TrackStats & { date: string })[]
  by_lead: (TrackStats & { lead: string })[]
  // Per-city scores. Show a city's figures only once city_days reaches min_days_per_city.
  by_city: (TrackStats & { city: string })[]
  // Different (UTC) days with scores, per city, within the chosen period.
  city_days: Record<string, number>
  min_days_per_city: number
  // The ensemble's stored chances of rain, scored (Brier, lower is better); null without a table.
  rain_chance?: {
    wet_mm: number
    usual_share: number
    test_brier: number
    n: number
    first_valid_at: string | null
    brier?: number
    usual_brier?: number
    yesterday_brier?: number | null
    rain_share?: number
    reliability?: { band: string; n: number; said: number; rained: number }[]
  } | null
  source: string
  baseline: string
}

// Live track record over the last `days` days.
export async function getTrackRecord(days: number, signal?: AbortSignal): Promise<TrackRecord> {
  const { status, body } = await getJson(`/api/track-record?days=${days}`, signal)
  if (status !== 200) throw new ApiError('http', detailOf(body, `The track record returned an error (${status}).`), status)
  return body as TrackRecord
}

// An official warning, as issued (CAP fields).
export interface OfficialAlert {
  id: string | null
  event: string | null
  severity: 'Extreme' | 'Severe' | 'Moderate' | 'Minor' | 'Unknown' | null
  urgency: string | null
  certainty: string | null
  headline: string | null
  description: string | null
  instruction: string | null
  area: string | null
  onset: string | null
  expires: string | null
  sender: string | null
  link: string | null
}

export interface AlertsResult {
  coverage: 'india' | 'us' | 'none'
  checked_at: string
  feed_checked_at?: string | null
  stale: boolean
  error?: string
  source: { name: string; url: string } | null
  note: string
  alerts: OfficialAlert[]
}

// Official warnings near a point. The country code helps the server pick the right feed.
export async function getAlerts(latitude: number, longitude: number, country: string | undefined, signal?: AbortSignal): Promise<AlertsResult> {
  const params = new URLSearchParams({ latitude: latitude.toFixed(4), longitude: longitude.toFixed(4) })
  if (country && /^[A-Za-z]{2}$/.test(country)) params.set('country', country)
  const { status, body } = await getJson(`/api/alerts?${params}`, signal)
  if (status !== 200) throw new ApiError('http', detailOf(body, `The alerts service returned an error (${status}).`), status)
  return body as AlertsResult
}

export interface AssistantStatus {
  configured: boolean
  // "local" (the free model on the server's computer) or null when off.
  provider: 'local' | null
  model: string
  daily_limit_per_visitor: number
}

export interface AssistantTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface AssistantReply {
  reply: string
  sources: string[]
  model: string
}

// Thrown when the assistant can't answer: not set up, over a limit, or the service failed.
export class AssistantError extends ApiError {
  readonly code: string

  constructor(code: string, message: string, status?: number) {
    super('http', message, status)
    this.code = code
  }
}

// Whether the assistant is set up on the server.
export async function getAssistantStatus(signal?: AbortSignal): Promise<AssistantStatus> {
  const { status, body } = await getJson('/api/assistant/status', signal)
  if (status !== 200) throw new ApiError('http', detailOf(body, `The assistant service returned an error (${status}).`), status)
  return body as AssistantStatus
}

// Ask the assistant. Answers can take a while (it looks data up first), so the timeout is long.
export async function askAssistant(
  clientId: string,
  messages: AssistantTurn[],
  place: { name: string; latitude: number; longitude: number; country_code?: string },
  signal?: AbortSignal,
): Promise<AssistantReply> {
  const { status, body } = await getJson(
    '/api/assistant',
    signal,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client-Id': clientId }, body: JSON.stringify({ messages, place }) },
    120_000,
  )
  if (status === 200) return body as AssistantReply
  const code = body && typeof body === 'object' && 'code' in body && typeof body.code === 'string' ? body.code : 'http'
  throw new AssistantError(code, detailOf(body, `The assistant returned an error (${status}).`), status)
}

// The cities behind Wetcast's models: those they trained on and those held out to test them.
export async function getCoverage(signal?: AbortSignal): Promise<CoveredCity[]> {
  const { status, body } = await getJson('/api/coverage', signal)
  if (status !== 200) throw new ApiError('http', detailOf(body, `The prediction service returned an error (${status}).`), status)
  return body as CoveredCity[]
}

export interface Health {
  status: string
  database: string
  models: string[]
}

// Server health, used for the status shown in the app.
export async function getHealth(signal?: AbortSignal): Promise<Health> {
  const { status, body } = await getJson('/api/health', signal)
  if (status !== 200) throw new ApiError('http', detailOf(body, `The prediction service returned an error (${status}).`), status)
  return body as Health
}

// Saved places as stored on the server, keyed by an anonymous per-browser id.
export interface ServerPlace {
  place_id: string
  name: string
  admin1: string | null
  country: string | null
  latitude: number
  longitude: number
  is_home: boolean
}

// Saved places stored on the server for this browser's client id.
export async function getPlaces(clientId: string, signal?: AbortSignal): Promise<ServerPlace[]> {
  const { status, body } = await getJson('/api/places', signal, { headers: { 'X-Client-Id': clientId } })
  if (status !== 200) throw new ApiError('http', detailOf(body, `Saved places couldn't be loaded (${status}).`), status)
  return body as ServerPlace[]
}

// Replace the server's saved places for this client with the given list.
export async function replacePlaces(
  clientId: string,
  places: Omit<ServerPlace, 'is_home'>[],
  homePlaceId: string | null,
  signal?: AbortSignal,
): Promise<ServerPlace[]> {
  const { status, body } = await getJson('/api/places', signal, {
    method: 'PUT',
    headers: { 'X-Client-Id': clientId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ places, home_place_id: homePlaceId }),
  })
  if (status !== 200) throw new ApiError('http', detailOf(body, `Saved places couldn't be saved (${status}).`), status)
  return body as ServerPlace[]
}

// Names and units for the quantities the models predict.
export const TARGET_LABELS: Record<Target, string> = {
  temperature: 'Temperature',
  humidity: 'Humidity',
  precipitation: 'Rain',
}

export const TARGET_UNITS: Record<Target, string> = {
  temperature: '°C',
  humidity: '%',
  precipitation: 'mm',
}
