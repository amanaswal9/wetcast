/**
 * Client for WeatherAI's own FastAPI backend (/api, proxied by Vite in dev).
 * Every number here comes from trained models and real evaluation runs.
 */
import { log } from '../log'
import { ApiError } from './http'

export type Target = 'temperature' | 'humidity' | 'precipitation'

export interface CoveredCity {
  id: string
  name: string
  latitude: number
  longitude: number
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
}

export interface ModelPrediction {
  model: string
  display_name: string
  points: ModelPoint[]
}

export interface Predictions {
  city: CoveredCity
  issued_at: string
  interval_level: number
  source: string
  note: string
  models: ModelPrediction[]
}

export type PredictionsResult = { kind: 'ok'; data: Predictions } | { kind: 'unsupported'; supported: CoveredCity[]; detail: string }

export interface MetricSummary {
  mae: number
  rmse: number
  r2: number
  n: number
  unit: string
}

export interface StationSummary {
  mae: number
  rmse: number
  r2: number
  n: number
}

export interface ModelMetrics {
  model: string
  display_name: string
  test: Record<Target, MetricSummary>
  persistence_baseline: Record<Target, MetricSummary>
  interval: {
    level: number
    method: string
    halfwidth_by_horizon: Record<Target, number[]>
    test_coverage: Record<Target, number>
  }
  inference: { single_ms_median: number; batch256_ms_per_forecast: number; device: string; cpu: string }
  windows: { val: number; test: number }
  trained_at: string
  parameters: number
  config?: { lookback_hours: number; target_mode: 'direct' | 'residual24'; loss: 'mse' | 'huber'; train_stride_hours: number }
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
  /** "ensemble" averages other models; "gbm" is LightGBM (trees, no epochs). */
  kind?: 'ensemble' | 'gbm'
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
  station_check?: {
    available?: boolean
    reason?: string
    source?: string
    note?: string
    overall?: Partial<Record<'temperature' | 'humidity', Partial<Record<'lead6' | 'lead24' | 'open_meteo', StationSummary>>>>
  }
}

export interface Evaluation {
  model: string
  per_horizon_mae: Record<Target, number[]>
  per_city_mae: Record<Target, Record<string, number>>
  samples?: Record<string, Record<string, (string | number | null)[]>>
}

class BackendUnavailable extends ApiError {}

async function getJson(path: string, signal?: AbortSignal, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 20_000)
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
    if (body === null && !res.ok) throw new BackendUnavailable('network', "WeatherAI's prediction service isn't reachable.")
    return { status: res.status, body }
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError')
    log.warn('backend request failed', path, error)
    throw new BackendUnavailable('network', "WeatherAI's prediction service isn't reachable.")
  } finally {
    window.clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}

function detailOf(body: unknown, fallback: string): string {
  return body && typeof body === 'object' && 'detail' in body && typeof body.detail === 'string' ? body.detail : fallback
}

export async function getPredictions(latitude: number, longitude: number, signal?: AbortSignal): Promise<PredictionsResult> {
  const params = new URLSearchParams({ latitude: latitude.toFixed(4), longitude: longitude.toFixed(4) })
  const { status, body } = await getJson(`/api/predictions?${params}`, signal)
  if (status === 404 && body && typeof body === 'object' && 'code' in body && body.code === 'unsupported_location') {
    const b = body as unknown as { supported: CoveredCity[]; detail: string }
    return { kind: 'unsupported', supported: b.supported, detail: b.detail }
  }
  if (status !== 200) throw new ApiError('http', detailOf(body, `The prediction service returned an error (${status}).`), status)
  return { kind: 'ok', data: body as Predictions }
}

export async function getModels(signal?: AbortSignal): Promise<ModelMetrics[]> {
  const { status, body } = await getJson('/api/models', signal)
  if (status !== 200) throw new ApiError('http', detailOf(body, `The model service returned an error (${status}).`), status)
  return (body as { models: ModelMetrics[] }).models
}

export async function getEvaluation(model: string, options: { samplesFor?: string } = {}, signal?: AbortSignal): Promise<Evaluation> {
  const params = new URLSearchParams(options.samplesFor ? { city: options.samplesFor } : { include_samples: 'false' })
  const { status, body } = await getJson(`/api/models/${encodeURIComponent(model)}/evaluation?${params}`, signal)
  if (status !== 200) throw new ApiError('http', detailOf(body, `The model service returned an error (${status}).`), status)
  return body as Evaluation
}

/** One group of scored forecast hours from the live track record. */
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
  first_valid_at: string | null
  last_valid_at: string | null
  runs: number
  cities: number
  pending_points: number
  settle_hours: number
  /** How often the server issues and scores forecasts; 0 when the job is off. */
  interval_hours: number
  models: { model: string; display_name: string }[]
  totals: TrackStats[]
  daily: (TrackStats & { date: string })[]
  by_lead: (TrackStats & { lead: string })[]
  source: string
  baseline: string
}

export async function getTrackRecord(days: number, signal?: AbortSignal): Promise<TrackRecord> {
  const { status, body } = await getJson(`/api/track-record?days=${days}`, signal)
  if (status !== 200) throw new ApiError('http', detailOf(body, `The track record returned an error (${status}).`), status)
  return body as TrackRecord
}

export interface Health {
  status: string
  database: string
  models: string[]
}

export async function getHealth(signal?: AbortSignal): Promise<Health> {
  const { status, body } = await getJson('/api/health', signal)
  if (status !== 200) throw new ApiError('http', detailOf(body, `The prediction service returned an error (${status}).`), status)
  return body as Health
}

/** Saved places as stored on the server, keyed by an anonymous per-browser id. */
export interface ServerPlace {
  place_id: string
  name: string
  admin1: string | null
  country: string | null
  latitude: number
  longitude: number
  is_home: boolean
}

export async function getPlaces(clientId: string, signal?: AbortSignal): Promise<ServerPlace[]> {
  const { status, body } = await getJson('/api/places', signal, { headers: { 'X-Client-Id': clientId } })
  if (status !== 200) throw new ApiError('http', detailOf(body, `Saved places couldn't be loaded (${status}).`), status)
  return body as ServerPlace[]
}

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
