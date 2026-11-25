// The weather map's colour field: one image drawn from the grid of point forecasts.
//
// Values are blended between neighbouring points (bilinear interpolation) and only then given a
// band colour, so band edges follow the weather instead of the grid's squares. The image is laid
// out in Web Mercator rows, like the map, so each point sits exactly under its colour at any zoom.
// One image instead of a shape per point also keeps panning, zooming and the hour slider smooth.
import type { Band } from './mapScales'

export interface FieldPoint {
  latitude: number
  longitude: number
}

export interface Field {
  width: number
  height: number
  // RGBA pixels, row by row from the north-west corner.
  pixels: Uint8ClampedArray<ArrayBuffer>
  // [[south, west], [north, east]]: half a grid step beyond the outermost points.
  bounds: [[number, number], [number, number]]
}

// Image pixels per grid step across; the browser smooths the rest when it scales the image.
const PX_PER_STEP = 64
const MAX_SIDE = 1000

// Latitude to the map's vertical (Web Mercator) position.
function mercatorY(latitude: number): number {
  const phi = (latitude * Math.PI) / 180
  return Math.log(Math.tan(Math.PI / 4 + phi / 2))
}

// Back from a Web Mercator position to latitude.
function latitudeOf(y: number): number {
  return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI
}

// "#rrggbb" as red, green and blue numbers.
function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// Draw the field. `valueOf` gives a point's value (null when unknown); `bandFor` the band for a
// blended value (null leaves the pixel clear, e.g. rain below 0.1 mm). Returns null when there is
// nothing to draw.
export function renderField<P extends FieldPoint>(
  points: P[],
  latSpacing: number,
  lonSpacing: number,
  valueOf: (point: P) => number | null,
  bandFor: (value: number) => Band | null,
): Field | null {
  if (points.length === 0) return null
  const lats = [...new Set(points.map((p) => p.latitude))].sort((a, b) => b - a)
  const lons = [...new Set(points.map((p) => p.longitude))].sort((a, b) => a - b)
  const rows = lats.length
  const cols = lons.length
  const rowOf = new Map(lats.map((v, i) => [v, i]))
  const colOf = new Map(lons.map((v, i) => [v, i]))
  const grid = new Float64Array(rows * cols).fill(Number.NaN)
  let any = false
  for (const p of points) {
    const v = valueOf(p)
    if (v === null || !Number.isFinite(v)) continue
    grid[rowOf.get(p.latitude)! * cols + colOf.get(p.longitude)!] = v
    any = true
  }
  if (!any) return null

  const north = Math.min(lats[0] + latSpacing / 2, 85)
  const south = Math.max(lats[rows - 1] - latSpacing / 2, -85)
  const west = Math.max(lons[0] - lonSpacing / 2, -180)
  const east = Math.min(lons[cols - 1] + lonSpacing / 2, 180)
  const yNorth = mercatorY(north)
  const ySouth = mercatorY(south)
  const xSpan = ((east - west) * Math.PI) / 180
  let width = Math.round(((east - west) / lonSpacing) * PX_PER_STEP)
  let height = Math.round((width * (yNorth - ySouth)) / xSpan)
  const shrink = Math.max(width / MAX_SIDE, height / MAX_SIDE, 1)
  width = Math.max(2, Math.round(width / shrink))
  height = Math.max(2, Math.round(height / shrink))

  const colours = new Map<Band, [number, number, number]>()
  // RGB for a band's colour, worked out once per band.
  const colourOf = (band: Band) => {
    let c = colours.get(band)
    if (!c) colours.set(band, (c = rgb(band.color)))
    return c
  }

  // Fractional grid column for each image column (the same for every row).
  const colPos = new Float64Array(width)
  for (let x = 0; x < width; x++) {
    const lon = west + ((x + 0.5) / width) * (east - west)
    colPos[x] = Math.min(Math.max((lon - lons[0]) / lonSpacing, 0), cols - 1)
  }

  const pixels = new Uint8ClampedArray(width * height * 4)
  // Blend the four surrounding points, leaving out any not loaded yet.
  let sum = 0
  let weight = 0
  // Adds one grid point's value to the blend when its weight is positive and it has loaded.
  const add = (r: number, c: number, w: number) => {
    const v = grid[r * cols + c]
    if (w > 0 && !Number.isNaN(v)) {
      sum += v * w
      weight += w
    }
  }
  for (let y = 0; y < height; y++) {
    const lat = latitudeOf(yNorth - ((y + 0.5) / height) * (yNorth - ySouth))
    const fr = Math.min(Math.max((lats[0] - lat) / latSpacing, 0), rows - 1)
    const r0 = Math.floor(fr)
    const r1 = Math.min(r0 + 1, rows - 1)
    const dr = fr - r0
    for (let x = 0; x < width; x++) {
      const fc = colPos[x]
      const c0 = Math.floor(fc)
      const c1 = Math.min(c0 + 1, cols - 1)
      const dc = fc - c0
      sum = 0
      weight = 0
      add(r0, c0, (1 - dr) * (1 - dc))
      add(r0, c1, (1 - dr) * dc)
      add(r1, c0, dr * (1 - dc))
      add(r1, c1, dr * dc)
      if (weight === 0) continue
      const band = bandFor(sum / weight)
      if (!band) continue
      const [red, green, blue] = colourOf(band)
      const i = (y * width + x) * 4
      pixels[i] = red
      pixels[i + 1] = green
      pixels[i + 2] = blue
      pixels[i + 3] = 255
    }
  }
  return { width, height, pixels, bounds: [[south, west], [north, east]] }
}
