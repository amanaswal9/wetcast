import { useCallback, useState } from 'react'
import { PLACE_KEY, readPlace } from '../lib/openingPlace'
import { writeJson } from '../lib/storage'
import type { Place } from '../types/weather'

export { DEFAULT_PLACE, readPlace } from '../lib/openingPlace'

// The place being viewed, remembered in this browser.
export function usePlace() {
  const [place, setPlaceState] = useState<Place>(readPlace)

  const setPlace = useCallback((next: Place) => {
    setPlaceState(next)
    writeJson(PLACE_KEY, next)
  }, [])

  return [place, setPlace] as const
}
