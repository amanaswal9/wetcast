import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, isAbort } from '../lib/api/http'
import { getPlaces, replacePlaces, type ServerPlace } from '../lib/api/weatherai'
import { log } from '../lib/log'
import { EMPTY_SAVED as EMPTY, isSavedState, SAVED_KEY as KEY, type SavedState } from '../lib/openingPlace'
import { readJson, readString, writeJson, writeString } from '../lib/storage'
import type { Place } from '../types/weather'

// Saved places and the home location.
//
// PostgreSQL (through /api/places) is the source of truth. This browser keeps a
// copy so the app opens instantly, works when the server is down, and knows the
// home city before anything loads. Places are filed under an anonymous random
// id created in this browser; there are no accounts.
//
// Sync rules:
//  - On load, take the server's list, unless this browser has changes the
//    server hasn't received yet ("dirty"), or has never synced and the server
//    is empty (first run: migrate the places saved before the server existed).
//    In those cases the browser's list is sent up instead.
//  - Every change is applied here at once, then sent as a full replacement.
//    Sends run one at a time and always carry the latest state, so a slow
//    request can't overwrite a newer one.
//  - If the server can't be reached, changes stay here, marked dirty, and are
//    sent on the next change, the next load or when the browser comes back online.
const META_KEY = 'weatherai.saved.meta'
const CLIENT_KEY = 'weatherai.clientId'
// Most places a viewer can save.
export const MAX_SAVED = 8

interface SyncMeta {
  dirty: boolean
  synced: boolean
}

export type SyncStatus = 'connecting' | 'synced' | 'saving' | 'offline' | 'rejected'

// Checks the stored sync notes are the shape this code writes.
function isMeta(value: unknown): value is SyncMeta {
  return !!value && typeof value === 'object' && typeof (value as SyncMeta).dirty === 'boolean' && typeof (value as SyncMeta).synced === 'boolean'
}

// A random id; the getRandomValues route is for browsers without randomUUID.
function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// Anonymous id for this browser, created once.
export function getClientId(): string {
  const existing = readString(CLIENT_KEY)
  if (existing && /^[A-Za-z0-9-]{8,64}$/.test(existing)) return existing
  const id = randomId()
  writeString(CLIENT_KEY, id)
  return id
}

// A saved place as the server stores it, cut to the server's length limits.
function toServer(p: Place): Omit<ServerPlace, 'is_home'> {
  return {
    place_id: p.id.slice(0, 64),
    name: p.name.slice(0, 120),
    admin1: p.admin1?.slice(0, 120) ?? null,
    country: p.country?.slice(0, 120) ?? null,
    latitude: p.latitude,
    longitude: p.longitude,
  }
}

// The server's rows back into places, and which one is home.
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

// Same place if the ids match or the coordinates are within ~1 km.
export function samePlace(a: Place, b: Place): boolean {
  return a.id === b.id || (Math.abs(a.latitude - b.latitude) < 0.01 && Math.abs(a.longitude - b.longitude) < 0.01)
}

export { readHome } from '../lib/openingPlace'

export type AddResult = 'added' | 'exists' | 'full'

// The saved places and home city, kept in step with the server by the rules at the top of this file.
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

  // Send the latest state. Calls are serialised; each one reads state when it runs.
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
        // A 4xx means the server refused this list; retrying the same list won't help.
        const rejected = error instanceof ApiError && error.kind === 'http' && (error.status ?? 0) < 500
        setStatus(rejected ? 'rejected' : 'offline')
      }
    })
  }, [clientId, saveMeta])

  // Load the server's list and reconcile it with this browser's copy.
  const syncWithServer = useCallback(
    (signal?: AbortSignal) => {
      const editsAtStart = edits.current
      getPlaces(clientId, signal)
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
          if (signal?.aborted || isAbort(error)) return
          log.warn('saved places: server unreachable, using this browser’s copy', error)
          setStatus('offline')
        })
    },
    [clientId, apply, pushLatest, saveMeta],
  )

  // Initial sync.
  useEffect(() => {
    const controller = new AbortController()
    syncWithServer(controller.signal)
    return () => controller.abort()
  }, [syncWithServer])

  // Sync again when the connection comes back or the tab returns to the foreground.
  useEffect(() => {
    const onOnline = () => syncWithServer()
    const onVisible = () => {
      if (document.visibilityState === 'visible') syncWithServer()
    }
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [syncWithServer])

  // Another tab changed the saved places: take its version so this tab doesn't
  // later send an older list and undo that change.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== KEY || event.newValue === null) return
      try {
        const next: unknown = JSON.parse(event.newValue)
        if (isSavedState(next)) {
          stateRef.current = next
          setState(next)
        }
      } catch {
        // Ignore malformed values.
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const commit = useCallback(
    (next: SavedState) => {
      edits.current += 1
      apply(next)
      saveMeta({ ...meta.current, dirty: true })
      pushLatest()
    },
    [apply, saveMeta, pushLatest],
  )

  // Changes are built from stateRef (always current), not the last render's state,
  // so two quick changes in a row can't overwrite each other.
  const isSaved = useCallback((place: Place) => state.places.some((p) => samePlace(p, place)), [state.places])

  const add = useCallback(
    (place: Place): AddResult => {
      const current = stateRef.current
      if (current.places.some((p) => samePlace(p, place))) return 'exists'
      if (current.places.length >= MAX_SAVED) return 'full'
      commit({ ...current, places: [...current.places, place] })
      return 'added'
    },
    [commit],
  )

  const remove = useCallback(
    (place: Place) => {
      const current = stateRef.current
      const places = current.places.filter((p) => !samePlace(p, place))
      const homeStillSaved = places.some((p) => p.id === current.homeId)
      commit({ places, homeId: homeStillSaved ? current.homeId : null })
    },
    [commit],
  )

  const setHome = useCallback(
    (place: Place | null) => {
      const current = stateRef.current
      if (place === null) {
        commit({ ...current, homeId: null })
        return
      }
      const existing = current.places.find((p) => samePlace(p, place))
      if (existing) {
        commit({ ...current, homeId: existing.id })
      } else if (current.places.length < MAX_SAVED) {
        commit({ places: [...current.places, place], homeId: place.id })
      }
    },
    [commit],
  )

  const retrySync = useCallback(() => {
    setStatus('connecting')
    syncWithServer()
  }, [syncWithServer])

  const home = state.places.find((p) => p.id === state.homeId) ?? null

  return { places: state.places, home, isSaved, add, remove, setHome, syncStatus: status, retrySync }
}

export type SavedPlaces = ReturnType<typeof useSavedPlaces>
