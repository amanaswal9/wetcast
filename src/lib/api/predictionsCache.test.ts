import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPredictions } from './weatherai'

const OK = { city: { id: 'delhi', name: 'Delhi', latitude: 28.6, longitude: 77.2 }, issued_at: 'x', interval_level: 0.8, source: '', note: '', models: [] }

function mockFetch(status = 200, body: unknown = OK) {
  vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }) // tests run without a browser
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => vi.unstubAllGlobals())

describe('predictions cache', () => {
  it('shares one request between callers and reuses the answer', async () => {
    const fetchMock = mockFetch()
    const [a, b] = await Promise.all([getPredictions(10.001, 20.001), getPredictions(10.001, 20.001)])
    expect(a).toEqual(b)
    await getPredictions(10.001, 20.001)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await getPredictions(10.001, 20.001, undefined, true) // Refresh skips the cache
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('lets one caller cancel without breaking the shared request', async () => {
    mockFetch()
    const controller = new AbortController()
    const cancelled = getPredictions(11.002, 21.002, controller.signal)
    const other = getPredictions(11.002, 21.002)
    controller.abort()
    await expect(cancelled).rejects.toThrow('Request cancelled')
    await expect(other).resolves.toEqual({ kind: 'ok', data: OK })
  })

  it('never keeps a failure', async () => {
    const failing = mockFetch(500, { detail: 'boom' })
    await expect(getPredictions(12.003, 22.003)).rejects.toThrow()
    expect(failing).toHaveBeenCalledTimes(1)
    const ok = mockFetch()
    await expect(getPredictions(12.003, 22.003)).resolves.toEqual({ kind: 'ok', data: OK })
    expect(ok).toHaveBeenCalledTimes(1)
  })
})
