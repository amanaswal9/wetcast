import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OfficialAlert } from './api/weatherai'

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  }
}

const alert = (id: string | null, event = 'Heavy rain'): OfficialAlert =>
  ({ id, event, severity: 'Moderate', onset: '2026-11-20T06:00:00Z', area: 'Delhi' }) as OfficialAlert

describe('warning notifications: each warning once', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('localStorage', memoryStorage())
  })

  it('treats new warnings as unseen until marked', async () => {
    const { markSeen, unseen } = await import('./alertNotifications')
    const a = alert('a')
    const b = alert('b')
    expect(unseen([a, b])).toEqual([a, b])
    markSeen([a])
    expect(unseen([a, b])).toEqual([b])
    markSeen([b])
    expect(unseen([a, b])).toEqual([])
  })

  it('recognises warnings without an id by event, start and area', async () => {
    const { markSeen, unseen } = await import('./alertNotifications')
    markSeen([alert(null)])
    expect(unseen([alert(null)])).toEqual([])
    expect(unseen([alert(null, 'Heat wave')])).toHaveLength(1)
  })

  it('remembers a bounded number of warnings', async () => {
    const { markSeen, unseen } = await import('./alertNotifications')
    markSeen(Array.from({ length: 350 }, (_, i) => alert(`x${i}`)))
    expect(JSON.parse(localStorage.getItem('weatherai.alerts.seen')!)).toHaveLength(300)
    expect(unseen([alert('x349')])).toEqual([]) // the newest are kept
  })

  it('is off when the browser has no notifications', async () => {
    const { setAlertNotifications } = await import('./alertNotifications')
    expect(await setAlertNotifications(true)).toBe('unsupported')
  })
})
