import { getWeekForecast } from './api/openMeteo'
import { getPredictions } from './api/weatherai'
import { log } from './log'
import type { Place } from '../types/weather'

// Run a moment later, when the browser is idle, so prefetching never competes with what's on screen.
// The pause lets the weather that has just arrived be drawn first.
export function whenIdle(task: () => void): () => void {
  let cancelIdle = () => {}
  const timer = globalThis.setTimeout(() => {
    if ('requestIdleCallback' in window) {
      const id = window.requestIdleCallback(task, { timeout: 4000 })
      cancelIdle = () => window.cancelIdleCallback(id)
    } else {
      task()
    }
  }, 1000)
  return () => {
    globalThis.clearTimeout(timer)
    cancelIdle()
  }
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

