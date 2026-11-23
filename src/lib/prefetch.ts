import { getAirQuality, getForecast, getWeekForecast } from './api/openMeteo'
import { getPredictions } from './api/weatherai'
import { log } from './log'
import type { Place } from '../types/weather'

// Run when the browser is idle, so prefetching never competes with what's on screen.
function whenIdle(task: () => void): () => void {
  if ('requestIdleCallback' in window) {
    const id = window.requestIdleCallback(task, { timeout: 4000 })
    return () => window.cancelIdleCallback(id)
  }
  const id = globalThis.setTimeout(task, 1500)
  return () => globalThis.clearTimeout(id)
}

// Quietly fetch what the Forecast page needs for a place (the 7-day forecast and
// Wetcast's predictions), so opening it is instant. Both are cached by their API
// clients; failures are ignored here because the page loads them again on its own.
// Returns a function that cancels a prefetch that hasn't started yet.
export function prefetchPlace(place: Place): () => void {
  return whenIdle(() => {
    getWeekForecast(place).catch((e: unknown) => log.debug('prefetch week failed', e))
    getPredictions(place.latitude, place.longitude, undefined, false, place.countryCode).catch((e: unknown) => log.debug('prefetch predictions failed', e))
  })
}

// Ask for the opening place's weather as soon as the code has loaded, before the first render. The
// app's own requests join these when they start, so the weather arrives sooner and is fetched once.
export function prefetchOpeningWeather(place: Place): void {
  getForecast(place).catch((e: unknown) => log.debug('early forecast failed', e))
  getAirQuality(place).catch((e: unknown) => log.debug('early air quality failed', e))
}
