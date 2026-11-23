import { textBox } from '../lib/asciiArt'
import { placeShortLabel } from '../lib/format'
import type { Format } from '../lib/units'
import { describeWeather } from '../lib/weatherCodes'
import type { Forecast, Place } from '../types/weather'

interface DesktopArtProps {
  place: Place
  forecast: Forecast | undefined
  fmt: Format
}

// The desktop behind the window: a small note of the place and its weather, drawn in plain
// characters. It shows below a short window and in full view when the window is minimised.
// Screen readers skip it: the same facts are on the Dashboard.
export function DesktopArt({ place, forecast, fmt }: DesktopArtProps) {
  const current = forecast?.current
  const today = forecast?.daily[0]

  const note = current
    ? textBox(
        [
          placeShortLabel(place),
          `${fmt.t(current.temperature)}   ${describeWeather(current.weatherCode, current.isDay)}`,
          today?.tempMax != null && today.tempMin != null ? `High ${fmt.deg(today.tempMax)}   Low ${fmt.deg(today.tempMin)}` : '',
        ].filter(Boolean),
      )
    : textBox(['Wetcast', 'Loading the weather...'])

  return (
    <div aria-hidden="true" className="r-desktop-art">
      <pre>{note.join('\n')}</pre>
    </div>
  )
}
