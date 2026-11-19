/**
 * Colour bands for the weather map. Discrete steps (not a smooth gradient) so a
 * square's colour maps to one legend entry, read the same way in both themes.
 */

export type MapLayer = 'temperature' | 'rain' | 'wind'

export interface Band {
  /** Values from `min` (inclusive) up to the next band's `min`. */
  min: number
  color: string
  label: string
}

export const LAYER_INFO: Record<MapLayer, { label: string; unit: string; description: string }> = {
  temperature: { label: 'Temperature', unit: '°C', description: 'Air temperature 2 m above ground' },
  rain: { label: 'Rain', unit: 'mm', description: 'Rain, showers and snow (as water) in the hour' },
  wind: { label: 'Wind', unit: 'km/h', description: 'Wind 10 m above ground; arrows point where the wind blows to' },
}

export const TEMPERATURE_BANDS: Band[] = [
  { min: -Infinity, color: '#4b0082', label: 'below −20' },
  { min: -20, color: '#3a2fb8', label: '−20 to −10' },
  { min: -10, color: '#2366d1', label: '−10 to 0' },
  { min: 0, color: '#3ba3e0', label: '0 to 5' },
  { min: 5, color: '#5cc8c0', label: '5 to 10' },
  { min: 10, color: '#7fd17f', label: '10 to 15' },
  { min: 15, color: '#c7e05a', label: '15 to 20' },
  { min: 20, color: '#f2d43c', label: '20 to 25' },
  { min: 25, color: '#f59d2a', label: '25 to 30' },
  { min: 30, color: '#e8612a', label: '30 to 35' },
  { min: 35, color: '#c62828', label: '35 to 40' },
  { min: 40, color: '#7b0d1e', label: '40 and above' },
]

/** Below 0.1 mm the square is left empty: no rain to show. */
export const RAIN_BANDS: Band[] = [
  { min: 0.1, color: '#a6d8f0', label: '0.1 to 0.5' },
  { min: 0.5, color: '#5aa9e6', label: '0.5 to 1' },
  { min: 1, color: '#2a6fdb', label: '1 to 2' },
  { min: 2, color: '#1b3fa0', label: '2 to 5' },
  { min: 5, color: '#6a1b9a', label: '5 to 10' },
  { min: 10, color: '#c2185b', label: '10 and above' },
]

export const WIND_BANDS: Band[] = [
  { min: 0, color: '#7a7a7a', label: 'below 10 (light)' },
  { min: 10, color: '#2a8f4a', label: '10 to 20' },
  { min: 20, color: '#c9a400', label: '20 to 40' },
  { min: 40, color: '#e06000', label: '40 to 60 (strong)' },
  { min: 60, color: '#b00020', label: '60 and above (gale)' },
]

export const BANDS: Record<MapLayer, Band[]> = { temperature: TEMPERATURE_BANDS, rain: RAIN_BANDS, wind: WIND_BANDS }

/** The band a value falls in, or null when there is nothing to draw. */
export function bandFor(layer: MapLayer, value: number | null): Band | null {
  if (value === null || !Number.isFinite(value)) return null
  const bands = BANDS[layer]
  if (value < bands[0].min) return null
  let found = bands[0]
  for (const b of bands) if (value >= b.min) found = b
  return found
}

/**
 * Direction the wind blows towards, in degrees. Weather data gives the
 * direction it comes from (a "north wind", 0°, blows towards the south).
 */
export function blowingTowards(fromDegrees: number): number {
  return (fromDegrees + 180) % 360
}
