import { log } from '../log'

// 'no-server' is the public copy, which has no Wetcast server to ask (src/lib/site.ts).
export type ApiErrorKind = 'network' | 'timeout' | 'http' | 'invalid' | 'no-server'

// An error with a message that is safe and useful to show to people.
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

// Turn anything thrown into an ApiError with a message fit to show.
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  return new ApiError('network', "Something went wrong while loading weather data. Try again.")
}

// True when a request was cancelled on purpose, which is not worth reporting.
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
  // Keep the response in memory for this long. 0 disables caching.
  ttlMs?: number
  // Skip the cache and fetch again (used by the Refresh button).
  fresh?: boolean
  timeoutMs?: number
}

// A request on its way, shared by everyone asking for the same address at the same time (the early
// start in main.tsx and the page that wants the answer, for example). It is cancelled only when every
// caller has given up.
interface Pending {
  promise: Promise<unknown>
  controller: AbortController
  callers: number
}

const pending = new Map<string, Pending>()

// The error a cancelled request ends with, the same kind fetch itself uses.
function cancelled(): DOMException {
  return new DOMException('Request cancelled', 'AbortError')
}

// fetch() wrapper with a timeout, an in-memory TTL cache, shared requests and friendly errors.
// Caller cancellation is re-thrown as the original AbortError so components can ignore it.
export async function fetchJson(url: string, options: FetchJsonOptions = {}): Promise<unknown> {
  const { signal, ttlMs = 0, fresh = false, timeoutMs = 12_000 } = options

  const hit = cache.get(url)
  if (!fresh && hit && hit.expires > Date.now()) {
    log.debug('cache hit', url)
    return hit.value
  }
  if (signal?.aborted) throw cancelled()

  let entry = fresh ? undefined : pending.get(url)
  if (!entry) {
    const controller = new AbortController()
    const started: Pending = { promise: request(url, controller, ttlMs, timeoutMs), controller, callers: 0 }
    pending.set(url, started)
    const forget = () => {
      if (pending.get(url) === started) pending.delete(url)
    }
    started.promise.then(forget, forget)
    entry = started
  } else {
    log.debug('joined a request already on its way', url)
  }

  const shared = entry
  shared.callers++
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      shared.callers--
      if (shared.callers === 0) {
        if (pending.get(url) === shared) pending.delete(url)
        shared.controller.abort()
      }
      reject(cancelled())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    shared.promise.then(
      (value) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

// The fetch itself. It is cancelled through `controller` once nobody wants the answer any more.
async function request(url: string, controller: AbortController, ttlMs: number, timeoutMs: number): Promise<unknown> {
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

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
    if (timedOut) throw new ApiError('timeout', 'The weather service took too long to respond. Try again.')
    if (controller.signal.aborted) throw cancelled()
    log.warn('network error', url, error)
    throw new ApiError('network', "Can't reach the weather service. Check your connection and try again.")
  } finally {
    clearTimeout(timer)
  }
}

// Test helper.
export function clearHttpCache(): void {
  cache.clear()
  pending.clear()
}
