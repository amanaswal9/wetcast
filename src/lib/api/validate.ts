import { ApiError } from './http'

// Minimal runtime checks for third-party JSON. If a provider changes its
// response shape we fail loudly with a clear message instead of rendering
// wrong numbers.
type Json = Record<string, unknown>

// The error thrown when a field has the wrong shape, naming the field.
function invalid(path: string): ApiError {
  return new ApiError('invalid', `The weather service sent data Wetcast couldn't read (${path}).`)
}

// Each helper returns the value with its type, or throws naming the field that was wrong.
// The OrNull and OrUndefined versions return a fallback instead of throwing.
export function obj(value: unknown, path: string): Json {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Json
  throw invalid(path)
}

// An array, or throws.
export function arr(value: unknown, path: string): unknown[] {
  if (Array.isArray(value)) return value
  throw invalid(path)
}

// A finite number, or throws.
export function num(value: unknown, path: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw invalid(path)
}

// A finite number, or null.
export function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// A non-empty string, or throws.
export function str(value: unknown, path: string): string {
  if (typeof value === 'string' && value.length > 0) return value
  throw invalid(path)
}

// A non-empty string, or undefined.
export function strOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// A non-empty string, or null.
export function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

// Read a parallel array from an Open-Meteo hourly/daily block, tolerating a missing series.
export function series(block: Json, key: string, length: number): unknown[] {
  const value = block[key]
  if (value === undefined) return new Array<unknown>(length).fill(null)
  const list = arr(value, key)
  if (list.length !== length) throw invalid(`${key} length`)
  return list
}
