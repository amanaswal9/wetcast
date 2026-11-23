import { useCallback, useState } from 'react'
import { writeString } from '../lib/storage'

// The three looks. "night" is the everyday dark mode; "dark" is the high-contrast scheme
// (its stored value stays "dark" so people who chose it before keep it).
export type Theme = 'light' | 'night' | 'dark'

const THEMES: Theme[] = ['light', 'night', 'dark']

// Title-bar colour per theme, used for the browser's own toolbar on phones.
const BROWSER_BAR: Record<Theme, string> = { light: '#000080', night: '#1f4e8c', dark: '#800080' }

// True for both dark looks: places that only need "light ink or dark ink" use this.
export function isDark(theme: Theme): boolean {
  return theme !== 'light'
}

function current(): Theme {
  const value = document.documentElement.dataset.theme
  return THEMES.includes(value as Theme) ? (value as Theme) : 'light'
}

// index.html sets data-theme before first paint; this hook reads and changes it.
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(current)

  const setTheme = useCallback((next: Theme) => {
    document.documentElement.dataset.theme = next
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BROWSER_BAR[next])
    writeString('weatherai.theme', next)
    setThemeState(next)
  }, [])

  // Each button turns its own look on, or back to light if it is already on.
  const toggleNight = useCallback(() => setTheme(theme === 'night' ? 'light' : 'night'), [theme, setTheme])
  const toggleContrast = useCallback(() => setTheme(theme === 'dark' ? 'light' : 'dark'), [theme, setTheme])

  return { theme, setTheme, toggleNight, toggleContrast }
}
