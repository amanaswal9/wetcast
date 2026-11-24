import { sitePath } from './site'

// A small world outline (Natural Earth, public domain; built by ml/weatherai_ml/build_map_outline.py)
// drawn under the weather map at once, so the map shows land and sea while OpenStreetMap's tiles are
// still loading. Each ring is stored as [lat0, lon0, dlat, dlon, ...] in hundredths of a degree.

export type Ring = [number, number][]

// Land outline file in public/, fetched when the map first opens.
export const OUTLINE_URL = sitePath('map-outline.json')

// Undo the whole-number steps: [lat, lon] pairs in degrees.
export function decodeRing(steps: number[]): Ring {
  const out: Ring = []
  let lat = 0
  let lon = 0
  for (let i = 0; i + 1 < steps.length; i += 2) {
    lat += steps[i]
    lon += steps[i + 1]
    out.push([lat / 100, lon / 100])
  }
  return out
}

// Decode the whole outline file into rings, skipping anything malformed.
export function decodeOutline(raw: unknown): Ring[] {
  const land = (raw as { land?: unknown })?.land
  if (!Array.isArray(land)) throw new Error('The map outline file is not in the expected format.')
  return land.filter((r): r is number[] => Array.isArray(r) && r.every((v) => typeof v === 'number')).map(decodeRing)
}

let loading: Promise<Ring[]> | null = null

// The outline, fetched once per page load (the service worker keeps it for offline use).
export function loadOutline(): Promise<Ring[]> {
  loading ??= fetch(OUTLINE_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`map outline: HTTP ${r.status}`)
      return r.json()
    })
    .then(decodeOutline)
    .catch((error: unknown) => {
      loading = null // try again next time the map opens
      throw error
    })
  return loading
}
