import { describe, expect, it } from 'vitest'
import type { RainWarning } from '../../lib/api/weatherai'
import { describeRainWarning, zoneOffsetSeconds } from './rainWarning'

const IST = 19_800
const hm = (local: string) => local.slice(11, 16)
const NOW = Date.parse('2026-11-26T12:00:00Z') // 17:30 in India

const base: RainWarning = {
  level: 'moderate',
  event_mm: 15.6,
  wet_hours: 9.4,
  total_mm: 18.26,
  peak_time: '2026-11-27T03:00:00Z',
  until: '2026-11-27T11:00:00Z',
  followed_by_rain: 0.517,
  caught: 0.626,
}

describe('describeRainWarning', () => {
  it('words a moderate-rain warning in the place’s own time, with its tested record', () => {
    const t = describeRainWarning(base, IST, hm, NOW)!
    expect(t.kind).toBe('warning')
    expect(t.title).toBe('Rain warning: 15.6 mm or more possible')
    expect(t.body).toContain('about 18 mm of rain by 16:30 tomorrow, most likely around 08:30 tomorrow')
    expect(t.record).toContain('52% of these warnings were followed by 15.6 mm or more')
    expect(t.record).toContain('63% of the times')
  })

  it('words a rain-likely notice and drops a peak that has passed', () => {
    const t = describeRainWarning({ ...base, level: 'rain', event_mm: 2.5, wet_hours: 4.3, total_mm: 2.44, peak_time: '2026-11-26T11:00:00Z' }, IST, hm, NOW)!
    expect(t.kind).toBe('info')
    expect(t.title).toBe('Rain likely in the next 24 hours')
    expect(t.body).toBe("Wetcast's models expect rain in about 4 of the hours up to 16:30 tomorrow, about 2.4 mm in all.")
  })

  it('shows nothing once every forecast hour is past, and no record when there is none', () => {
    expect(describeRainWarning(base, IST, hm, Date.parse('2026-11-27T11:00:00Z'))).toBeNull()
    expect(describeRainWarning({ ...base, caught: null }, IST, hm, NOW)!.record).toBeNull()
  })
})

describe('zoneOffsetSeconds', () => {
  it('finds a zone’s offset, half hours included', () => {
    expect(zoneOffsetSeconds('Asia/Kolkata', new Date(NOW))).toBe(IST)
    expect(zoneOffsetSeconds('UTC', new Date(NOW))).toBe(0)
  })
})
