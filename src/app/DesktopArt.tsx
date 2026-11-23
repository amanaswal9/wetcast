import { centre, skyFor, skylineLines, textBox } from '../lib/asciiArt'
import { placeShortLabel } from '../lib/format'
import type { Format } from '../lib/units'
import { describeWeather, weatherKind } from '../lib/weatherCodes'
import type { Forecast, Place } from '../types/weather'

interface DesktopArtProps {
  place: Place
  forecast: Forecast | undefined
  fmt: Format
}

// The desktop wallpaper: an ASCII scene of the current weather with a small note of the
// place and temperature. It sits behind the window, so it shows around it on wide screens
// and fills the screen when the window is minimised. Screen readers skip it: the same
// facts are on the Dashboard.
export function DesktopArt({ place, forecast, fmt }: DesktopArtProps) {
  const current = forecast?.current
  const today = forecast?.daily[0]
  const sky = current ? skyFor(weatherKind(current.weatherCode), current.isDay) : skyFor('cloudy', true)

  const note = current
    ? textBox([
        placeShortLabel(place),
        `${fmt.t(current.temperature)}   ${describeWeather(current.weatherCode, current.isDay)}`,
        today?.tempMax != null && today.tempMin != null ? `High ${fmt.deg(today.tempMax)}   Low ${fmt.deg(today.tempMin)}` : '',
      ].filter(Boolean))
    : textBox(['Wetcast', 'Loading the weather...'])

  // The sky and the note sit centred over the skyline, which is the widest part.
  const skyline = skylineLines()
  const width = Math.max(...skyline.map((row) => row.length))
  const art = [...centre(sky, width), '', ...skyline, '', ...centre(note, width)].join('\n')

  return (
    <div aria-hidden="true" className="r-desktop-art">
      <pre>{art}</pre>
    </div>
  )
}
