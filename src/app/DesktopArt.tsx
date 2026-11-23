import type { CSSProperties } from 'react'

// Personal desktop art, made on this computer by docs/share/make_wallpaper_ascii.py and kept out
// of git. When the file isn't there (a fresh copy of the project), the desktop stays plain.
// WALLPAPER is drawn in dark ink (line art on the light desktop); photos also bring
// WALLPAPER_LIGHT, drawn in light ink in every theme so a face reads the right way round.
const local = import.meta.glob<string[]>('../local/wallpaper.ts', { eager: true })
const file = Object.values(local)[0] as unknown as { WALLPAPER?: string[]; WALLPAPER_LIGHT?: string[] } | undefined
const INK = file?.WALLPAPER
const LIGHT = file?.WALLPAPER_LIGHT

// The desktop behind the window: the personal ASCII picture, if there is one. It shows below a
// short window and in full view when the window is minimised. Screen readers skip it.
export function DesktopArt() {
  if (!INK) return null
  // The row count lets the text size fit the whole picture into the screen's height.
  const size = { '--rows': INK.length } as CSSProperties
  return (
    <div aria-hidden="true" className="r-desktop-art" data-light-version={LIGHT ? 'true' : undefined}>
      <pre className="r-desktop-picture r-picture-ink" style={size}>
        {INK.join('\n')}
      </pre>
      {LIGHT && (
        <pre className="r-desktop-picture r-picture-light" style={size}>
          {LIGHT.join('\n')}
        </pre>
      )}
    </div>
  )
}
