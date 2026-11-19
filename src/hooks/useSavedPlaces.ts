import { useCallback, useEffect, useRef, useState } from 'react'
import { isAbort } from '../lib/api/http'
import { getPlaces, replacePlaces, type ServerPlace } from '../lib/api/weatherai'
import { log } from '../lib/log'
import { readJson, readString, writeJson, writeString } from '../lib/storage'
import type { Place } from '../types/weather'

/**
 * Saved places and the home location.
 *
 * PostgreSQL (through /api/places) is the source of truth. This browser keeps a
 * copy so the app opens instantly, works when the server is down, and knows the
 * home city before anything loads. Places are filed under an anonymous random
 * id created in this browser; there are no accounts.
 *
 * Sync rules:
 *  - On load, take the server's list, unless this browser has changes the
 *    server hasn't received yet ("dirty"), or has never synced and the server
 *    is empty (first run: migrate the places saved before the server existed).
 *    In those cases the browser's list is sent up instead.
 *  - Every change is applied here at once, then sent as a full replacement.
 *    Sends run one at a time and always carry the latest state, so a slow
 *    request can't overwrite a newer one.
 *  - If the server can't be reached, changes stay here, marked dirty, and are
 *    sent on the next change, the next load or when the browser comes back online.
 */
const KEY = 'weatherai.saved'
const META_KEY = 'weatherai.saved.meta'
const CLIENT_KEY = 'weatherai.clientId'
export const MAX_SAVED = 8

interface SavedState {
  places: Place[]
  homeId: string | null
}

interface SyncMeta {
  dirty: boolean
  synced: boolean
}

export type SyncStatus = 'connecting' | 'synced' | 'saving' | 'offline'

function isPlace(value: unknown): value is Place {
  if (!value || typeof value !== 'object') return false
  const p = value as Record<string, unknown>
  return typeof p.id === 'string' && typeof p.name === 'string' && typeof p.latitude === 'number' && typeof p.longitude === 'number'
}

function isSavedState(value: unknown): value is SavedState {
  if (!value || typeof value !== 'object') return false
  const s = value as Record<string, unknown>
  return Array.isArray(s.places) && s.places.every(isPlace) && (s.homeId === null || typeof s.homeId === 'string')
}

function isMeta(value: unknown): value is SyncMeta {
  return !!value && typeof value === 'object' && typeof (value as SyncMeta).dirty === 'boolean' && typeof (value as SyncMeta).synced === 'boolean'
}

const EMPTY: SavedState = { places: [], homeId: null }

function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Anonymous id for this browser, created once. */
function getClientId(): string {
  const existing = readString(CLIENT_KEY)
  if (existing && /^[A-Za-z0-9-]{8,64}$/.test(existing)) return existing
  const id = randomId()
  writeString(CLIENT_KEY, id)
  return id
}

function toServer(p: Place): Omit<ServerPlace, 'is_home'> {
  return {
    place_id: p.id.slice(0, 64),
    name: p.name.slice(0, 120),
    admin1: p.admin1 ?? null,
    country: p.country ?? null,
    latitude: p.latitude,
    longitude: p.longitude,
  }
}

function fromServer(rows: ServerPlace[]): SavedState {
  return {
    places: rows.map((r) => ({
      id: r.place_id,
      name: r.name,
      admin1: r.admin1 ?? undefined,
      country: r.country ?? undefined,
      latitude: r.latitude,
      longitude: r.longitude,
    })),
    homeId: rows.find((r) => r.is_home)?.place_id ?? null,
  }
}

/** Same place if the ids match or the coordinates are within ~1 km. */
export function samePlace(a: Place, b: Place): boolean {
  return a.id === b.id || (Math.abs(a.latitude - b.latitude) < 0.01 && Math.abs(a.longitude - b.longitude) < 0.01)
}

/** Home location from this browser's copy, readable before any network request. */
export function readHome(): Place | null {
  const state = readJson<SavedState>(KEY, EMPTY, isSavedState)
  return state.places.find((p) => p.id === state.homeId) ?? null
}

export type AddResult = 'added' | 'exists' | 'full'

export function useSavedPlaces() {
  const [clientId] = useState(getClientId)
  const [state, setState] = useState<SavedState>(() => readJson(KEY, EMPTY, isSavedState))
  const [status, setStatus] = useState<SyncStatus>('connecting')
  const stateRef = useRef(state)
  const meta = useRef<SyncMeta>(readJson(META_KEY, { dirty: false, synced: false }, isMeta))
  const queue = useRef<Promise<void>>(Promise.resolve())
  const edits = useRef(0)

  const saveMeta = useCallback((next: SyncMeta) => {
    meta.current = next
    writeJson(META_KEY, next)
  }, [])

  const apply = useCallback((next: SavedState) => {
    stateRef.current = next
    setState(next)
    writeJson(KEY, next)
  }, [])

  /** Send the latest state. Calls are serialised; each one reads state when it runs. */
  const pushLatest = useCallback(() => {
    queue.current = queue.current.then(async () => {
      const sending = stateRef.current
      setStatus('saving')
      try {
        await replacePlaces(clientId, sending.places.map(toServer), sending.homeId)
        if (stateRef.current === sending) saveMeta({ dirty: false, synced: true })
        setStatus('synced')
      } catch (error) {
        log.warn('saved places not synced', error)
        setStatus('offline')
      }
    })
  }, [clientId, saveMeta])

  // Initial sync with the server.
  useEffect(() => {
    const controller = new AbortController()
    const editsAtStart = edits.current
    getPlaces(clientId, controller.signal)
      .then((server) => {
        const local = stateRef.current
        const firstMigration = !meta.current.synced && server.length === 0 && local.places.length > 0
        // A change made while this request was in flight is newer than its answer.
        const editedMeanwhile = edits.current !== editsAtStart
        if (meta.current.dirty || firstMigration || editedMeanwhile) {
          pushLatest()
        } else {
          apply(fromServer(server))
          saveMeta({ dirty: false, synced: true })
          setStatus('synced')
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbort(error)) return
        log.warn('saved places: server unreachable, using this browser’s copy', error)
        setStatus('offline')
      })
    return () => controller.abort()
  }, [clientId, apply, pushLatest, saveMeta])

  // Retry pending changes when the browser reconnects.
  useEffect(() => {
    const onOnline = () => {
      if (meta.current.dirty) pushLatest()
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [pushLatest])

  const commit = useCallback(
    (next: SavedState) => {
      edits.current += 1
      apply(next)
      saveMeta({ ...meta.current, dirty: true })
      pushLatest()
    },
    [apply, saveMeta, pushLatest],
  )

  const isSaved = useCallback((place: Place) => state.places.some((p) => samePlace(p, place)), [state.places])

  const add = useCallback(
    (place: Place): AddResult => {
      if (state.places.some((p) => samePlace(p, place))) return 'exists'
      if (state.places.length >= MAX_SAVED) return 'full'
      commit({ ...state, places: [...state.places, place] })
      return 'added'
    },
    [state, commit],
  )

  const remove = useCallback(
    (place: Place) => {
      const places = state.places.filter((p) => !samePlace(p, place))
      const homeStillSaved = places.some((p) => p.id === state.homeId)
      commit({ places, homeId: homeStillSaved ? state.homeId : null })
    },
    [state, commit],
  )

  const setHome = useCallback(
    (place: Place | null) => {
      if (place === null) {
        commit({ ...state, homeId: null })
        return
      }
      const existing = state.places.find((p) => samePlace(p, place))
      if (existing) {
        commit({ ...state, homeId: existing.id })
      } else if (state.places.length < MAX_SAVED) {
        commit({ places: [...state.places, place], homeId: place.id })
      }
    },
    [state, commit],
  )

  const home = state.places.find((p) => p.id === state.homeId) ?? null

  return { places: state.places, home, isSaved, add, remove, setHome, syncStatus: status, retrySync: pushLatest }
}

export type SavedPlaces = ReturnType<typeof useSavedPlaces>
