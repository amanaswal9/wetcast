import type { Place } from '../types/weather'

/** "2026-11-19T13:15" -> "13:15". Open-Meteo times are already location-local. */
export function hhmm(isoLocal: string): string {
  return isoLocal.slice(11, 16)
}

/** "13:15" or an ISO string -> minutes since midnight. */
export function minutesOfDay(value: string): number {
  const time = value.length > 5 ? hhmm(value) : value
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

export function round(value: number): number {
  const r = Math.round(value)
  return Object.is(r, -0) ? 0 : r
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']

export function compass(degrees: number): string {
  const normalised = ((degrees % 360) + 360) % 360
  return COMPASS[Math.round(normalised / 22.5) % 16]
}

/** WHO UV index bands. */
export function uvCategory(uv: number): string {
  if (uv < 3) return 'Low'
  if (uv < 6) return 'Moderate'
  if (uv < 8) return 'High'
  if (uv < 11) return 'Very high'
  return 'Extreme'
}

/** European Air Quality Index bands (Copernicus CAMS). */
export function aqiCategory(aqi: number): string {
  if (aqi <= 20) return 'Good'
  if (aqi <= 40) return 'Fair'
  if (aqi <= 60) return 'Moderate'
  if (aqi <= 80) return 'Poor'
  if (aqi <= 100) return 'Very poor'
  return 'Extremely poor'
}

export function formatDuration(seconds: number): string {
  const totalMinutes = Math.round(seconds / 60)
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return `${h} h ${m} min`
}

export function placeLabel(place: Place): string {
  const parts = [place.name]
  if (place.admin1 && place.admin1 !== place.name) parts.push(place.admin1)
  if (place.country) parts.push(place.country)
  return parts.join(', ')
}

export function placeShortLabel(place: Place): string {
  return place.country ? `${place.name}, ${place.country}` : place.name
}

function noonOf(date: string): Date {
  // Noon avoids any daylight-saving edge when turning a date string into a weekday.
  return new Date(`${date}T12:00:00`)
}

/** "Today", "Tomorrow" (long only) or the weekday name. */
export function dayName(date: string, index: number, style: 'short' | 'long'): string {
  if (index === 0) return 'Today'
  if (index === 1 && style === 'long') return 'Tomorrow'
  return noonOf(date).toLocaleDateString('en-GB', { weekday: style })
}

/** "2026-11-19" -> "19 Nov". */
export function shortDate(date: string): string {
  return noonOf(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** UTC ISO time -> location-local "YYYY-MM-DDTHH:MM", matching Open-Meteo's local strings. */
export function utcToLocal(isoUtc: string, offsetSeconds: number): string {
  return new Date(Date.parse(isoUtc) + offsetSeconds * 1000).toISOString().slice(0, 16)
}

export function coordKey(place: Place): string {
  return `${place.latitude.toFixed(2)},${place.longitude.toFixed(2)}`
}

/** Viewer's own clock time, used for "updated at" and the taskbar. */
export function localClock(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
