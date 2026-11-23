import { ApiError } from './http'

/**
 * Minimal runtime checks for third-party JSON. If a provider changes its
 * response shape we fail loudly with a clear message instead of rendering
 * wrong numbers.
 */
type Json = Record<string, unknown>

function invalid(path: string): ApiError {
  return new ApiError('invalid', `The weather service sent data Wetcast couldn't read (${path}).`)
}

export function obj(value: unknown, path: string): Json {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Json
  throw invalid(path)
}

export function arr(value: unknown, path: string): unknown[] {
  if (Array.isArray(value)) return value
  throw invalid(path)
}

export function num(value: unknown, path: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw invalid(path)
}

export function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function str(value: unknown, path: string): string {
  if (typeof value === 'string' && value.length > 0) return value
  throw invalid(path)
}

export function strOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Read a parallel array from an Open-Meteo hourly/daily block, tolerating a missing series. */
export function series(block: Json, key: string, length: number): unknown[] {
  const value = block[key]
  if (value === undefined) return new Array<unknown>(length).fill(null)
  const list = arr(value, key)
  if (list.length !== length) throw invalid(`${key} length`)
  return list
}
