import type { Place } from '../types/weather'
import { readJson } from './storage'

// Which place the app opens on, read straight from this browser's storage. Kept free of React,
// so the start-up code can ask for that place's weather before the rest of the app has loaded.

export const PLACE_KEY = 'weatherai.place'
export const SAVED_KEY = 'weatherai.saved'

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

export interface SavedState {
  places: Place[]
  homeId: string | null
}

export const EMPTY_SAVED: SavedState = { places: [], homeId: null }

function isSavedPlace(value: unknown): value is Place {
  if (!value || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  return typeof p.id === 'string' && typeof p.name === 'string' && typeof p.latitude === 'number' && typeof p.longitude === 'number'
}

export function isSavedState(value: unknown): value is SavedState {
  if (!value || typeof value !== 'object') return false
  const s = value as Record<string, unknown>
  return Array.isArray(s.places) && s.places.every(isSavedPlace) && (s.homeId === null || typeof s.homeId === 'string')
}

// Home location from this browser's copy, readable before any network request.
export function readHome(): Place | null {
  const state = readJson<SavedState>(SAVED_KEY, EMPTY_SAVED, isSavedState)
  return state.places.find((p) => p.id === state.homeId) ?? null
}

function isPlace(value: unknown): value is Place {
  return isSavedPlace(value) && Math.abs(value.latitude) <= 90 && Math.abs(value.longitude) <= 180
}

// The place to open on: the home location when one is set, otherwise the last place viewed.
// Wetcast Mini reads it too, so it always shows the same place as the app.
export function readPlace(): Place {
  return readHome() ?? readJson(PLACE_KEY, DEFAULT_PLACE, isPlace)
}
