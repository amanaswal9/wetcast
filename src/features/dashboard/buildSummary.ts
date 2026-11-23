import { placeShortLabel } from '../../lib/format'
import type { Format } from '../../lib/units'
import { describeWeather } from '../../lib/weatherCodes'
import type { Forecast, Place } from '../../types/weather'

// Plain-language summary built only from the forecast data. Rule-based on
// purpose: no language model, so it can't invent conditions, and the wording
// says "likely"/"chance" because these are forecasts, not certainties.
export function buildSummary(place: Place, forecast: Forecast, fmt: Format): string {
  const { current, hourly, daily } = forecast
  const parts: string[] = []

  parts.push(
    `It's ${fmt.t(current.temperature)} and ${describeWeather(current.weatherCode, current.isDay).toLowerCase()} in ${place.name}, feeling like ${fmt.t(current.apparentTemperature)}.`,
  )

  const next12 = hourly.filter((h) => !h.isPast).slice(0, 12)
  const withChance = next12.filter((h) => h.precipitationProbability !== null)
  if (withChance.length > 0) {
    const peak = withChance.reduce((a, b) => ((b.precipitationProbability ?? 0) > (a.precipitationProbability ?? 0) ? b : a))
    const chance = peak.precipitationProbability ?? 0
    if (chance >= 50) parts.push(`Rain is likely around ${fmt.time(peak.time)}, with a ${chance}% chance.`)
    else if (chance >= 20) parts.push(`There's a ${chance}% chance of rain around ${fmt.time(peak.time)}.`)
    else parts.push('Rain is unlikely over the next 12 hours.')
  }

  const today = daily[0]
  if (today && today.tempMin !== null && today.tempMax !== null) {
    parts.push(`Today ranges from ${fmt.deg(today.tempMin)} to ${fmt.deg(today.tempMax)}.`)
  }

  return parts.join(' ')
}

// Heading for the summary, also used when it is read aloud.
export function summaryTitle(place: Place): string {
  return `Weather for ${placeShortLabel(place)}`
}
