import { log } from '../log'

export type ApiErrorKind = 'network' | 'timeout' | 'http' | 'invalid'

/** An error with a message that is safe and useful to show to people. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status?: number

  constructor(kind: ApiErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
  }
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  return new ApiError('network', "Something went wrong while loading weather data. Try again.")
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

interface CacheEntry {
  expires: number
  value: unknown
}

const cache = new Map<string, CacheEntry>()

export interface FetchJsonOptions {
  signal?: AbortSignal
  /** Keep the response in memory for this long. 0 disables caching. */
  ttlMs?: number
  /** Skip the cache and fetch again (used by the Refresh button). */
  fresh?: boolean
  timeoutMs?: number
}

/**
 * fetch() wrapper with a timeout, an in-memory TTL cache and friendly errors.
 * Caller cancellation is re-thrown as the original AbortError so components
 * can ignore it.
 */
export async function fetchJson(url: string, options: FetchJsonOptions = {}): Promise<unknown> {
  const { signal, ttlMs = 0, fresh = false, timeoutMs = 12_000 } = options

  const hit = cache.get(url)
  if (!fresh && hit && hit.expires > Date.now()) {
    log.debug('cache hit', url)
    return hit.value
  }

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const forwardAbort = () => controller.abort()
  signal?.addEventListener('abort', forwardAbort, { once: true })

  const started = performance.now()
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      let reason = ''
      try {
        const body: unknown = await response.json()
        if (body && typeof body === 'object' && 'reason' in body && typeof body.reason === 'string') {
          reason = body.reason
        }
      } catch {
        // Body was not JSON; fall back to the status code.
      }
      log.warn('http error', response.status, url, reason)
      throw new ApiError('http', `The weather service returned an error (${response.status}). Try again in a minute.`, response.status)
    }
    const value: unknown = await response.json()
    log.debug('fetched', url, `${Math.round(performance.now() - started)} ms`)
    if (ttlMs > 0) cache.set(url, { value, expires: Date.now() + ttlMs })
    return value
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError')
    if (timedOut) throw new ApiError('timeout', 'The weather service took too long to respond. Try again.')
    log.warn('network error', url, error)
    throw new ApiError('network', "Can't reach the weather service. Check your connection and try again.")
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forwardAbort)
  }
}

/** Test helper. */
export function clearHttpCache(): void {
  cache.clear()
}
