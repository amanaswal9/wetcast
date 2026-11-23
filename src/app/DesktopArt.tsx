import { textBox } from '../lib/asciiArt'
import { placeShortLabel } from '../lib/format'
import { RONIN_INK, RONIN_LIGHT } from '../lib/roninArt'
import type { Format } from '../lib/units'
import { describeWeather } from '../lib/weatherCodes'
import type { Forecast, Place } from '../types/weather'

interface DesktopArtProps {
  place: Place
  forecast: Forecast | undefined
  fmt: Format
}

// The ronin without the blank line each template literal starts and ends with. The ink version
// suits the light desktop; the light version, drawn in bright characters, suits the dark themes.
const INK = RONIN_INK.slice(1, -1)
const LIGHT = RONIN_LIGHT.slice(1, -1)

// The desktop wallpaper: an original ASCII drawing of a ronin at prayer (docs/share/ronin.svg,
// turned into text by docs/share/make_ronin_ascii.py), with a small note of the weather beside
// it. It sits behind the window, so it shows around it on wide screens and fills the screen when
// the window is minimised. Screen readers skip it: the same facts are on the Dashboard.
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
      <pre className="r-desktop-figure r-figure-ink">{INK}</pre>
      <pre className="r-desktop-figure r-figure-light">{LIGHT}</pre>
      <pre className="r-desktop-note">{note.join('\n')}</pre>
    </div>
  )
}
