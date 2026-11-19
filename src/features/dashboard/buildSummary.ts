import { hhmm, placeShortLabel, round } from '../../lib/format'
import { describeWeather } from '../../lib/weatherCodes'
import type { Forecast, Place } from '../../types/weather'

/**
 * Plain-language summary built only from the forecast data. Rule-based on
 * purpose: no language model, so it can't invent conditions, and the wording
 * says "likely"/"chance" because these are forecasts, not certainties.
 */
export function buildSummary(place: Place, forecast: Forecast): string {
  const { current, hourly, daily } = forecast
  const parts: string[] = []

  parts.push(
    `It's ${round(current.temperature)}°C and ${describeWeather(current.weatherCode, current.isDay).toLowerCase()} in ${place.name}, feeling like ${round(current.apparentTemperature)}°C.`,
  )

  const next12 = hourly.filter((h) => !h.isPast).slice(0, 12)
  const withChance = next12.filter((h) => h.precipitationProbability !== null)
  if (withChance.length > 0) {
    const peak = withChance.reduce((a, b) => ((b.precipitationProbability ?? 0) > (a.precipitationProbability ?? 0) ? b : a))
    const chance = peak.precipitationProbability ?? 0
    if (chance >= 50) parts.push(`Rain is likely around ${hhmm(peak.time)}, with a ${chance}% chance.`)
    else if (chance >= 20) parts.push(`There's a ${chance}% chance of rain around ${hhmm(peak.time)}.`)
    else parts.push('Rain is unlikely over the next 12 hours.')
  }

  const today = daily[0]
  if (today && today.tempMin !== null && today.tempMax !== null) {
    parts.push(`Today ranges from ${round(today.tempMin)}° to ${round(today.tempMax)}°.`)
  }

  return parts.join(' ')
}

export function summaryTitle(place: Place): string {
  return `Weather for ${placeShortLabel(place)}`
}
