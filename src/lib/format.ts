import type { Place } from '../types/weather'

// "2026-11-19T13:15" -> "13:15". Open-Meteo times are already location-local.
export function hhmm(isoLocal: string): string {
  return isoLocal.slice(11, 16)
}

// "13:15" or an ISO string -> minutes since midnight.
export function minutesOfDay(value: string): number {
  const time = value.length > 5 ? hhmm(value) : value
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

// Round to a whole number without ever showing "-0".
export function round(value: number): number {
  const r = Math.round(value)
  return Object.is(r, -0) ? 0 : r
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']

// "28.50° N, 77.25° E"
export function latLonLabel(latitude: number, longitude: number): string {
  const ns = latitude >= 0 ? 'N' : 'S'
  const ew = longitude >= 0 ? 'E' : 'W'
  return `${Math.abs(latitude).toFixed(2)}° ${ns}, ${Math.abs(longitude).toFixed(2)}° ${ew}`
}

// Sixteen-point compass name for a bearing in degrees.
export function compass(degrees: number): string {
  const normalised = ((degrees % 360) + 360) % 360
  return COMPASS[Math.round(normalised / 22.5) % 16]
}

// WHO UV index bands.
export function uvCategory(uv: number): string {
  if (uv < 3) return 'Low'
  if (uv < 6) return 'Moderate'
  if (uv < 8) return 'High'
  if (uv < 11) return 'Very high'
  return 'Extreme'
}

// European Air Quality Index bands (Copernicus CAMS).
export function aqiCategory(aqi: number): string {
  if (aqi <= 20) return 'Good'
  if (aqi <= 40) return 'Fair'
  if (aqi <= 60) return 'Moderate'
  if (aqi <= 80) return 'Poor'
  if (aqi <= 100) return 'Very poor'
  return 'Extremely poor'
}

// Seconds as "10 h 32 min", for day length.
export function formatDuration(seconds: number): string {
  const totalMinutes = Math.round(seconds / 60)
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return `${h} h ${m} min`
}

// Full place name: town, region and country, skipping repeats.
export function placeLabel(place: Place): string {
  const parts = [place.name]
  if (place.admin1 && place.admin1 !== place.name) parts.push(place.admin1)
  if (place.country) parts.push(place.country)
  return parts.join(', ')
}

// Shorter place name: town and country.
export function placeShortLabel(place: Place): string {
  return place.country ? `${place.name}, ${place.country}` : place.name
}

function noonOf(date: string): Date {
  // Noon avoids any daylight-saving edge when turning a date string into a weekday.
  return new Date(`${date}T12:00:00`)
}

const formatters = new Map<string, Intl.DateTimeFormat>()

// A date/time formatter for these options, built once and reused. Creating one is slow
// (toLocaleString does it on every call), and pages format hundreds of dates.
export function dateFormatter(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`
  let formatter = formatters.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options)
    formatters.set(key, formatter)
  }
  return formatter
}

// "Today", "Tomorrow" (long only) or the weekday name.
export function dayName(date: string, index: number, style: 'short' | 'long'): string {
  if (index === 0) return 'Today'
  if (index === 1 && style === 'long') return 'Tomorrow'
  return dateFormatter('en-GB', { weekday: style }).format(noonOf(date))
}

// "2026-11-19" -> "19 Nov".
export function shortDate(date: string): string {
  return dateFormatter('en-GB', { day: 'numeric', month: 'short' }).format(noonOf(date))
}

// UTC ISO time -> location-local "YYYY-MM-DDTHH:MM", matching Open-Meteo's local strings.
export function utcToLocal(isoUtc: string, offsetSeconds: number): string {
  return new Date(Date.parse(isoUtc) + offsetSeconds * 1000).toISOString().slice(0, 16)
}

// Cache key for a place, to two decimal places (about 1 km).
export function coordKey(place: Place): string {
  return `${place.latitude.toFixed(2)},${place.longitude.toFixed(2)}`
}

// Viewer's own clock time, used for "updated at" and the taskbar.
export function localClock(date: Date): string {
  return dateFormatter(undefined, { hour: '2-digit', minute: '2-digit' }).format(date)
}
