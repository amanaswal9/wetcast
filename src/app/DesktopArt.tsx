import type { CSSProperties } from 'react'

// Personal desktop art, made on this computer by docs/share/make_wallpaper_ascii.py and kept out
// of git. When the file isn't there (a fresh copy of the project), the desktop stays plain.
const local = import.meta.glob<string[]>('../local/wallpaper.ts', { eager: true, import: 'WALLPAPER' })
const rows = Object.values(local)[0]
const WALLPAPER = rows?.join('\n') ?? null

// The desktop behind the window: the personal ASCII picture, if there is one. It shows below a
// short window and in full view when the window is minimised. Screen readers skip it.
export function DesktopArt() {
  if (!WALLPAPER) return null
  // The row count lets the text size fit the whole picture into the screen's height.
  return (
    <div aria-hidden="true" className="r-desktop-art">
      <pre className="r-desktop-picture" style={{ '--rows': rows.length } as CSSProperties}>
        {WALLPAPER}
      </pre>
    </div>
  )
}
