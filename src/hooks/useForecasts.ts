import { toApiError } from '../lib/api/http'
import { getForecast } from '../lib/api/openMeteo'
import { coordKey } from '../lib/format'
import type { Forecast, Place } from '../types/weather'
import { useResource } from './useResource'

export interface PlaceForecast {
  place: Place
  forecast: Forecast | null
  /** Set when this one place failed; the others still show. */
  error: string | null
}

/** Forecasts for several places at once. One failing city doesn't fail the rest. */
export function useForecasts(places: Place[]) {
  const key = places.map(coordKey).join('|')
  return useResource<PlaceForecast[]>(
    places.length > 0 ? key : null,
    async ({ signal, fresh }) => {
      const results = await Promise.allSettled(places.map((p) => getForecast(p, { signal, fresh })))
      if (signal.aborted) throw new DOMException('Request cancelled', 'AbortError')
      return results.map((result, i) => ({
        place: places[i],
        forecast: result.status === 'fulfilled' ? result.value : null,
        error: result.status === 'rejected' ? toApiError(result.reason).message : null,
      }))
    },
    10 * 60_000,
  )
}
