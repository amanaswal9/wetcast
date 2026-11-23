import type { CSSProperties } from 'react'
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

// Personal desktop art, made on this computer by docs/share/make_wallpaper_ascii.py and kept out
// of git. When the file isn't there (a fresh copy of the project), the desktop shows only the note.
const local = import.meta.glob<string[]>('../local/wallpaper.ts', { eager: true, import: 'WALLPAPER' })
const rows = Object.values(local)[0]
const WALLPAPER = rows?.join('\n') ?? null

// The desktop behind the window: the personal ASCII picture, if there is one, and a small note
// of the place and its weather. Both show below a short window and in full view when the window
// is minimised. Screen readers skip them: the same facts are on the Dashboard.
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
      {WALLPAPER && (
        // The row count lets the text size fit the whole picture into the screen's height.
        <pre className="r-desktop-picture" style={{ '--rows': rows.length } as CSSProperties}>
          {WALLPAPER}
        </pre>
      )}
      <pre>{note.join('\n')}</pre>
    </div>
  )
}
