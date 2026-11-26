import type { RainWarning } from '../../lib/api/weatherai'
import { utcToLocal } from '../../lib/format'

export interface RainWarningText {
  kind: 'warning' | 'info'
  title: string
  body: string
  record: string | null
}

// "today", "tomorrow" or the weekday, for a place-local "YYYY-MM-DDTHH:MM" seen from place-local `today`.
function dayWord(local: string, today: string): string {
  const days = Math.round((Date.parse(`${local.slice(0, 10)}T00:00Z`) - Date.parse(`${today.slice(0, 10)}T00:00Z`)) / 86_400_000)
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  return new Date(`${local.slice(0, 10)}T12:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })
}

const pct = (share: number) => `${Math.round(share * 100)}%`

// The words for Wetcast's own rain warning at a place `offsetSeconds` from UTC, or null when its
// forecast hours are all past. `time` formats a place-local "YYYY-MM-DDTHH:MM" in the chosen clock.
export function describeRainWarning(w: RainWarning, offsetSeconds: number, time: (local: string) => string, now = Date.now()): RainWarningText | null {
  if (Date.parse(w.until) <= now) return null
  const today = utcToLocal(new Date(now).toISOString(), offsetSeconds)
  const until = utcToLocal(w.until, offsetSeconds)
  const peak = utcToLocal(w.peak_time, offsetSeconds)
  const by = `${time(until)} ${dayWord(until, today)}`
  const around = Date.parse(w.peak_time) > now ? `, most likely around ${time(peak)} ${dayWord(peak, today)}` : ''
  const total = w.total_mm >= 10 ? Math.round(w.total_mm) : Math.round(w.total_mm * 10) / 10
  const body =
    w.level === 'moderate'
      ? `Wetcast's models expect about ${total} mm of rain by ${by}${around}: moderate rain or more, in IMD's terms for a day's rain.`
      : `Wetcast's models expect rain in about ${Math.max(1, Math.round(w.wet_hours))} of the hours up to ${by}${around}, about ${total} mm in all.`
  const record =
    w.followed_by_rain !== null && w.caught !== null
      ? `Tested on 2026 weather the models never saw: ${pct(w.followed_by_rain)} of these warnings were followed by ${w.event_mm} mm or more within 24 hours, and they came before ${pct(w.caught)} of the times that much fell.`
      : null
  return {
    kind: w.level === 'moderate' ? 'warning' : 'info',
    title: w.level === 'moderate' ? `Rain warning: ${w.event_mm} mm or more possible` : 'Rain likely in the next 24 hours',
    body,
    record,
  }
}

// A time zone's current offset from UTC in seconds ("Asia/Kolkata" -> 19800); the viewer's own if unknown.
export function zoneOffsetSeconds(timeZone: string, now = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(now)
    const n = (type: string) => Number(parts.find((p) => p.type === type)?.value)
    const local = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'))
    return Math.round((local - Math.floor(now.getTime() / 60_000) * 60_000) / 60_000) * 60
  } catch {
    return -now.getTimezoneOffset() * 60
  }
}
