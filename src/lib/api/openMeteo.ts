import type {
  AirQuality,
  CurrentWeather,
  DailySummary,
  DayDetail,
  Forecast,
  HourlyPoint,
  Place,
  WeekForecast,
  WeekHour,
} from '../../types/weather'
import { fetchJson } from './http'
import { arr, num, numOrNull, obj, series, str, strOrNull, strOrUndefined } from './validate'

// Open-Meteo client. Free for non-commercial use, no API key required.
// Docs: https://open-meteo.com/en/docs
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const AIR_QUALITY_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality'

const MINUTE = 60_000

const CURRENT_VARS = [
  'temperature_2m',
  'relative_humidity_2m',
  'apparent_temperature',
  'is_day',
  'precipitation',
  'weather_code',
  'cloud_cover',
  'pressure_msl',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'uv_index',
]

const HOURLY_VARS = ['temperature_2m', 'relative_humidity_2m', 'precipitation_probability', 'precipitation', 'wind_speed_10m']

const DAILY_VARS = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'sunrise',
  'sunset',
  'daylight_duration',
  'uv_index_max',
  'precipitation_probability_max',
]

// The hourly view shows the past 12 hours and the current hour plus the next 24.
export const PAST_HOURS = 12
export const FORECAST_HOURS = 25

// Round coordinates so nearby requests share a cache entry (~1 km).
function coord(value: number): string {
  return value.toFixed(2)
}

interface RequestOptions {
  signal?: AbortSignal
  fresh?: boolean
}

// Open-Meteo URL for the dashboard forecast.
export function buildForecastUrl(place: Pick<Place, 'latitude' | 'longitude'>): string {
  const params = new URLSearchParams({
    latitude: coord(place.latitude),
    longitude: coord(place.longitude),
    current: CURRENT_VARS.join(','),
    hourly: HOURLY_VARS.join(','),
    daily: DAILY_VARS.join(','),
    timezone: 'auto',
    past_hours: String(PAST_HOURS),
    forecast_hours: String(FORECAST_HOURS),
    forecast_days: '7',
  })
  return `${FORECAST_URL}?${params}`
}

// Check and reshape the dashboard forecast response.
export function parseForecast(raw: unknown, fetchedAt: number): Forecast {
  const root = obj(raw, 'response')
  const timezone = str(root.timezone, 'timezone')

  const c = obj(root.current, 'current')
  const current: CurrentWeather = {
    time: str(c.time, 'current.time'),
    temperature: num(c.temperature_2m, 'current.temperature_2m'),
    apparentTemperature: num(c.apparent_temperature, 'current.apparent_temperature'),
    humidity: num(c.relative_humidity_2m, 'current.relative_humidity_2m'),
    precipitation: num(c.precipitation, 'current.precipitation'),
    weatherCode: num(c.weather_code, 'current.weather_code'),
    cloudCover: num(c.cloud_cover, 'current.cloud_cover'),
    isDay: num(c.is_day, 'current.is_day') === 1,
    windSpeed: num(c.wind_speed_10m, 'current.wind_speed_10m'),
    windDirection: num(c.wind_direction_10m, 'current.wind_direction_10m'),
    windGusts: numOrNull(c.wind_gusts_10m),
    pressure: num(c.pressure_msl, 'current.pressure_msl'),
    uvIndex: numOrNull(c.uv_index),
  }

  const h = obj(root.hourly, 'hourly')
  const hourTimes = arr(h.time, 'hourly.time').map((t, i) => str(t, `hourly.time[${i}]`))
  const n = hourTimes.length
  const temps = series(h, 'temperature_2m', n)
  const humidity = series(h, 'relative_humidity_2m', n)
  const precipProb = series(h, 'precipitation_probability', n)
  const precip = series(h, 'precipitation', n)
  const wind = series(h, 'wind_speed_10m', n)
  const hourly: HourlyPoint[] = hourTimes.map((time, i) => ({
    time,
    temperature: numOrNull(temps[i]),
    humidity: numOrNull(humidity[i]),
    precipitationProbability: numOrNull(precipProb[i]),
    precipitation: numOrNull(precip[i]),
    windSpeed: numOrNull(wind[i]),
    // Both strings are location-local and zero-padded, so string order is time order.
    isPast: time <= current.time,
  }))

  const d = obj(root.daily, 'daily')
  const days = arr(d.time, 'daily.time').map((t, i) => str(t, `daily.time[${i}]`))
  const m = days.length
  const code = series(d, 'weather_code', m)
  const tMax = series(d, 'temperature_2m_max', m)
  const tMin = series(d, 'temperature_2m_min', m)
  const sunrise = series(d, 'sunrise', m)
  const sunset = series(d, 'sunset', m)
  const daylight = series(d, 'daylight_duration', m)
  const uvMax = series(d, 'uv_index_max', m)
  const ppMax = series(d, 'precipitation_probability_max', m)
  const daily: DailySummary[] = days.map((date, i) => ({
    date,
    weatherCode: numOrNull(code[i]),
    tempMax: numOrNull(tMax[i]),
    tempMin: numOrNull(tMin[i]),
    sunrise: strOrNull(sunrise[i]),
    sunset: strOrNull(sunset[i]),
    daylightSeconds: numOrNull(daylight[i]),
    uvIndexMax: numOrNull(uvMax[i]),
    precipitationProbabilityMax: numOrNull(ppMax[i]),
  }))

  return { timezone, current, hourly, daily, fetchedAt }
}

// Dashboard forecast for a place, cached for ten minutes.
export async function getForecast(place: Place, { signal, fresh }: RequestOptions = {}): Promise<Forecast> {
  const raw = await fetchJson(buildForecastUrl(place), { signal, fresh, ttlMs: 10 * MINUTE })
  return parseForecast(raw, Date.now())
}

const WEEK_HOURLY_VARS = ['temperature_2m', 'precipitation_probability', 'precipitation', 'wind_speed_10m', 'weather_code']
const WEEK_DAILY_VARS = [
  ...DAILY_VARS,
  'precipitation_sum',
  'wind_speed_10m_max',
  'wind_gusts_10m_max',
  'wind_direction_10m_dominant',
]

// Open-Meteo URL for the seven-day forecast with hourly detail.
export function buildWeekUrl(place: Pick<Place, 'latitude' | 'longitude'>): string {
  const params = new URLSearchParams({
    latitude: coord(place.latitude),
    longitude: coord(place.longitude),
    current: 'weather_code',
    hourly: WEEK_HOURLY_VARS.join(','),
    daily: WEEK_DAILY_VARS.join(','),
    timezone: 'auto',
    forecast_days: '7',
  })
  return `${FORECAST_URL}?${params}`
}

// Check and reshape the seven-day forecast response.
export function parseWeek(raw: unknown, fetchedAt: number): WeekForecast {
  const root = obj(raw, 'response')
  const timezone = str(root.timezone, 'timezone')
  const currentTime = str(obj(root.current, 'current').time, 'current.time')

  const h = obj(root.hourly, 'hourly')
  const times = arr(h.time, 'hourly.time').map((t, i) => str(t, `hourly.time[${i}]`))
  const n = times.length
  const temps = series(h, 'temperature_2m', n)
  const pp = series(h, 'precipitation_probability', n)
  const precip = series(h, 'precipitation', n)
  const wind = series(h, 'wind_speed_10m', n)
  const codes = series(h, 'weather_code', n)
  const hourly: WeekHour[] = times.map((time, i) => ({
    time,
    temperature: numOrNull(temps[i]),
    precipitationProbability: numOrNull(pp[i]),
    precipitation: numOrNull(precip[i]),
    windSpeed: numOrNull(wind[i]),
    weatherCode: numOrNull(codes[i]),
    isPast: time <= currentTime,
  }))

  const d = obj(root.daily, 'daily')
  const days = arr(d.time, 'daily.time').map((t, i) => str(t, `daily.time[${i}]`))
  const m = days.length
  // One daily series by its key, filled with nulls if Open-Meteo left it out.
  const col = (key: string) => series(d, key, m)
  const [code, tMax, tMin, rise, set, daylight, uv, ppMax, pSum, wMax, gMax, wDir] = [
    'weather_code',
    'temperature_2m_max',
    'temperature_2m_min',
    'sunrise',
    'sunset',
    'daylight_duration',
    'uv_index_max',
    'precipitation_probability_max',
    'precipitation_sum',
    'wind_speed_10m_max',
    'wind_gusts_10m_max',
    'wind_direction_10m_dominant',
  ].map(col)
  const daily: DayDetail[] = days.map((date, i) => ({
    date,
    weatherCode: numOrNull(code[i]),
    tempMax: numOrNull(tMax[i]),
    tempMin: numOrNull(tMin[i]),
    sunrise: strOrNull(rise[i]),
    sunset: strOrNull(set[i]),
    daylightSeconds: numOrNull(daylight[i]),
    uvIndexMax: numOrNull(uv[i]),
    precipitationProbabilityMax: numOrNull(ppMax[i]),
    precipitationSum: numOrNull(pSum[i]),
    windSpeedMax: numOrNull(wMax[i]),
    windGustsMax: numOrNull(gMax[i]),
    windDirection: numOrNull(wDir[i]),
  }))

  const utcOffsetSeconds = num(root.utc_offset_seconds, 'utc_offset_seconds')
  return { timezone, utcOffsetSeconds, currentTime, hourly, daily, fetchedAt }
}

// Seven-day forecast for a place, cached for ten minutes.
export async function getWeekForecast(place: Place, { signal, fresh }: RequestOptions = {}): Promise<WeekForecast> {
  const raw = await fetchJson(buildWeekUrl(place), { signal, fresh, ttlMs: 10 * MINUTE })
  return parseWeek(raw, Date.now())
}

const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive'

export interface HistoryDay {
  date: string
  tempMax: number | null
  tempMin: number | null
  tempMean: number | null
  precipitationSum: number | null
}

// Daily history from Open-Meteo's ERA5 archive, which runs about 5 days behind today.
export async function getDailyHistory(place: Place, days: number, { signal }: RequestOptions = {}): Promise<HistoryDay[]> {
  const end = new Date(Date.now() - 6 * 86_400_000)
  const start = new Date(end.getTime() - (days - 1) * 86_400_000)
  // A date as YYYY-MM-DD (UTC).
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const params = new URLSearchParams({
    latitude: coord(place.latitude),
    longitude: coord(place.longitude),
    start_date: iso(start),
    end_date: iso(end),
    daily: 'temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum',
    timezone: 'auto',
  })
  const raw = await fetchJson(`${ARCHIVE_URL}?${params}`, { signal, ttlMs: 6 * 60 * MINUTE })
  const d = obj(obj(raw, 'response').daily, 'daily')
  const dates = arr(d.time, 'daily.time').map((t, i) => str(t, `daily.time[${i}]`))
  const n = dates.length
  const [max, min, mean, sum] = ['temperature_2m_max', 'temperature_2m_min', 'temperature_2m_mean', 'precipitation_sum'].map((k) => series(d, k, n))
  return dates.map((date, i) => ({
    date,
    tempMax: numOrNull(max[i]),
    tempMin: numOrNull(min[i]),
    tempMean: numOrNull(mean[i]),
    precipitationSum: numOrNull(sum[i]),
  }))
}

// Check and reshape geocoding results into places.
export function parsePlaces(raw: unknown): Place[] {
  const root = obj(raw, 'response')
  // Open-Meteo omits "results" entirely when nothing matches.
  if (root.results === undefined) return []
  return arr(root.results, 'results').map((item, i) => {
    const r = obj(item, `results[${i}]`)
    return {
      id: String(num(r.id, `results[${i}].id`)),
      name: str(r.name, `results[${i}].name`),
      admin1: strOrUndefined(r.admin1),
      country: strOrUndefined(r.country),
      countryCode: strOrUndefined(r.country_code),
      latitude: num(r.latitude, `results[${i}].latitude`),
      longitude: num(r.longitude, `results[${i}].longitude`),
    }
  })
}

// Places matching a name. Queries shorter than two letters return nothing.
export async function searchPlaces(query: string, { signal }: RequestOptions = {}): Promise<Place[]> {
  const name = query.trim()
  if (name.length < 2) return []
  const params = new URLSearchParams({ name, count: '6', language: 'en', format: 'json' })
  const raw = await fetchJson(`${GEOCODING_URL}?${params}`, { signal, ttlMs: 60 * MINUTE })
  return parsePlaces(raw)
}

// Check and reshape the air quality response.
export function parseAirQuality(raw: unknown): AirQuality {
  const root = obj(raw, 'response')
  const c = obj(root.current, 'current')
  return {
    time: str(c.time, 'current.time'),
    europeanAqi: numOrNull(c.european_aqi),
    pm2_5: numOrNull(c.pm2_5),
    pm10: numOrNull(c.pm10),
  }
}

// Current air quality for a place, cached for half an hour.
export async function getAirQuality(place: Place, { signal, fresh }: RequestOptions = {}): Promise<AirQuality> {
  const params = new URLSearchParams({
    latitude: coord(place.latitude),
    longitude: coord(place.longitude),
    current: 'european_aqi,pm2_5,pm10',
    timezone: 'auto',
  })
  const raw = await fetchJson(`${AIR_QUALITY_URL}?${params}`, { signal, fresh, ttlMs: 30 * MINUTE })
  return parseAirQuality(raw)
}
