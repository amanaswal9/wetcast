import { useCallback, useState } from 'react'
import { readJson, writeJson } from '../lib/storage'
import type { Place } from '../types/weather'
import { readHome } from './useSavedPlaces'

const KEY = 'weatherai.place'

// Shown on first visit until someone searches or uses their location.
export const DEFAULT_PLACE: Place = {
  id: '2643743',
  name: 'London',
  admin1: 'England',
  country: 'United Kingdom',
  countryCode: 'GB',
  latitude: 51.50853,
  longitude: -0.12574,
}

function isPlace(value: unknown): value is Place {
  if (!value || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.latitude === 'number' &&
    typeof p.longitude === 'number' &&
    Math.abs(p.latitude) <= 90 &&
    Math.abs(p.longitude) <= 180
  )
}

// The place being viewed, remembered in this browser.
export function usePlace() {
  // Open on the home location when one is set, otherwise the last place viewed.
  const [place, setPlaceState] = useState<Place>(() => readHome() ?? readJson(KEY, DEFAULT_PLACE, isPlace))

  const setPlace = useCallback((next: Place) => {
    setPlaceState(next)
    writeJson(KEY, next)
  }, [])

  return [place, setPlace] as const
}
