import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearHttpCache, fetchJson } from './http'

// A fetch stand-in whose answers arrive only when the test says so.
function slowFetch() {
  const calls: { url: string; signal: AbortSignal; answer: (body: unknown) => void }[] = []
  const fake = vi.fn((url: string, init: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      const signal = init.signal as AbortSignal
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      calls.push({ url, signal, answer: (body) => resolve(new Response(JSON.stringify(body), { status: 200 })) })
    })
  })
  return { fake, calls }
}

describe('fetchJson sharing', () => {
  let net: ReturnType<typeof slowFetch>

  beforeEach(() => {
    clearHttpCache()
    net = slowFetch()
    vi.stubGlobal('fetch', net.fake)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends one request when two callers ask for the same address at once', async () => {
    const early = fetchJson('https://x.test/a', { ttlMs: 1000 })
    const page = fetchJson('https://x.test/a', { ttlMs: 1000 })
    expect(net.fake).toHaveBeenCalledTimes(1)
    net.calls[0].answer({ t: 1 })
    expect(await early).toEqual({ t: 1 })
    expect(await page).toEqual({ t: 1 })
  })

  it('keeps the request going while anyone still wants it', async () => {
    const early = fetchJson('https://x.test/b', { ttlMs: 1000 })
    const leaving = new AbortController()
    const page = fetchJson('https://x.test/b', { ttlMs: 1000, signal: leaving.signal })
    leaving.abort()
    await expect(page).rejects.toMatchObject({ name: 'AbortError' })
    expect(net.calls[0].signal.aborted).toBe(false)
    net.calls[0].answer({ t: 2 })
    expect(await early).toEqual({ t: 2 })
  })

  it('cancels the request once every caller has given up', async () => {
    const one = new AbortController()
    const two = new AbortController()
    const a = fetchJson('https://x.test/c', { signal: one.signal })
    const b = fetchJson('https://x.test/c', { signal: two.signal })
    one.abort()
    expect(net.calls[0].signal.aborted).toBe(false)
    two.abort()
    expect(net.calls[0].signal.aborted).toBe(true)
    await expect(a).rejects.toMatchObject({ name: 'AbortError' })
    await expect(b).rejects.toMatchObject({ name: 'AbortError' })
    // A later caller starts a new request rather than joining the cancelled one.
    const c = fetchJson('https://x.test/c')
    expect(net.fake).toHaveBeenCalledTimes(2)
    net.calls[1].answer({ t: 3 })
    expect(await c).toEqual({ t: 3 })
  })

  it('starts a new request when asked for fresh data', () => {
    void fetchJson('https://x.test/d', { ttlMs: 1000 }).catch(() => {})
    void fetchJson('https://x.test/d', { ttlMs: 1000, fresh: true }).catch(() => {})
    expect(net.fake).toHaveBeenCalledTimes(2)
  })
})
