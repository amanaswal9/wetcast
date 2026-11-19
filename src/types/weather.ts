/**
 * Domain types for weather data.
 *
 * Every value carries an implicit source. On the Dashboard all data comes from
 * Open-Meteo's numerical forecast models: "past hours" are model estimates for
 * hours that have already happened, not station observations. Station
 * observations (Meteostat) and WeatherAI's own model predictions arrive in
 * later stages and get their own types.
 */

export interface Place {
  id: string
  name: string
  admin1?: string
  country?: string
  countryCode?: string
  latitude: number
  longitude: number
}

export interface CurrentWeather {
  /** Location-local ISO time without offset, e.g. "2026-11-19T13:15". */
  time: string
  temperature: number
  apparentTemperature: number
  humidity: number
  precipitation: number
  weatherCode: number
  cloudCover: number
  isDay: boolean
  windSpeed: number
  windDirection: number
  windGusts: number | null
  pressure: number
  uvIndex: number | null
}

export interface HourlyPoint {
  time: string
  temperature: number | null
  humidity: number | null
  precipitationProbability: number | null
  precipitation: number | null
  windSpeed: number | null
  /** True for hours at or before the current reading. */
  isPast: boolean
}

export interface DailySummary {
  date: string
  weatherCode: number | null
  tempMax: number | null
  tempMin: number | null
  sunrise: string | null
  sunset: string | null
  daylightSeconds: number | null
  uvIndexMax: number | null
  precipitationProbabilityMax: number | null
}

export interface Forecast {
  timezone: string
  current: CurrentWeather
  hourly: HourlyPoint[]
  daily: DailySummary[]
  /** Epoch ms when this response was fetched. */
  fetchedAt: number
}

/** One hour of the 7-day forecast (Forecast page). */
export interface WeekHour {
  time: string
  temperature: number | null
  precipitationProbability: number | null
  precipitation: number | null
  windSpeed: number | null
  weatherCode: number | null
  /** Hours before the current reading; Open-Meteo model estimates. */
  isPast: boolean
}

export interface DayDetail extends DailySummary {
  precipitationSum: number | null
  windSpeedMax: number | null
  windGustsMax: number | null
  windDirection: number | null
}

export interface WeekForecast {
  timezone: string
  utcOffsetSeconds: number
  currentTime: string
  hourly: WeekHour[]
  daily: DayDetail[]
  fetchedAt: number
}

export interface AirQuality {
  time: string
  europeanAqi: number | null
  pm2_5: number | null
  pm10: number | null
}
