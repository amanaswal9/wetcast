import { useCallback, useState } from 'react'
import { writeString } from '../lib/storage'

export type Theme = 'light' | 'dark'

// index.html sets data-theme before first paint; this hook reads and changes it.
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  )

  const setTheme = useCallback((next: Theme) => {
    document.documentElement.dataset.theme = next
    writeString('weatherai.theme', next)
    setThemeState(next)
  }, [])

  const toggle = useCallback(() => setTheme(theme === 'dark' ? 'light' : 'dark'), [theme, setTheme])

  return { theme, setTheme, toggle }
}
