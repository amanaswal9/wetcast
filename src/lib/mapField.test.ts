import { describe, expect, it } from 'vitest'
import { renderField } from './mapField'
import { bandFor, RAIN_BANDS, TEMPERATURE_BANDS } from './mapScales'

/** A 3×3 grid, 1° apart, around (20, 78). */
const POINTS = [21, 20, 19].flatMap((latitude) => [77, 78, 79].map((longitude) => ({ latitude, longitude, key: `${latitude},${longitude}` })))

function pixelAt(field: NonNullable<ReturnType<typeof renderField>>, fx: number, fy: number) {
  const x = Math.min(Math.floor(fx * field.width), field.width - 1)
  const y = Math.min(Math.floor(fy * field.height), field.height - 1)
  const i = (y * field.width + x) * 4
  return Array.from(field.pixels.slice(i, i + 4))
}

const hex = (rgba: number[]) => `#${rgba.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')}`

describe('renderField', () => {
  it('covers half a step beyond the outermost points', () => {
    const field = renderField(POINTS, 1, 1, () => 20, (v) => bandFor('temperature', v))!
    expect(field.bounds).toEqual([
      [18.5, 76.5],
      [21.5, 79.5],
    ])
    // Taller than wide on Mercator only by a hair this close to the equator.
    expect(field.width).toBe(192)
    expect(field.height).toBeGreaterThanOrEqual(192)
    expect(hex(pixelAt(field, 0.5, 0.5))).toBe(TEMPERATURE_BANDS.find((b) => b.min === 20)!.color)
  })

  it('blends values between points before colouring them', () => {
    // West column 10 °C, east column 30 °C: the middle column blends to 20 °C.
    const field = renderField(POINTS, 1, 1, (p) => (p.longitude === 77 ? 10 : p.longitude === 79 ? 30 : 20), (v) => bandFor('temperature', v))!
    expect(hex(pixelAt(field, 0.02, 0.5))).toBe(TEMPERATURE_BANDS.find((b) => b.min === 10)!.color)
    expect(hex(pixelAt(field, 0.98, 0.5))).toBe(TEMPERATURE_BANDS.find((b) => b.min === 30)!.color)
    // A quarter of the way from the west point to the middle one: 12.5 °C.
    expect(hex(pixelAt(field, (0.5 + 0.25) / 3, 0.5))).toBe(TEMPERATURE_BANDS.find((b) => b.min === 10)!.color)
    // Three quarters of the way: 17.5 °C.
    expect(hex(pixelAt(field, (0.5 + 0.75) / 3, 0.5))).toBe(TEMPERATURE_BANDS.find((b) => b.min === 15)!.color)
  })

  it('leaves dry places and points not loaded yet clear', () => {
    const field = renderField(POINTS, 1, 1, (p) => (p.longitude === 79 ? null : p.longitude === 77 ? 3 : 0), (v) => bandFor('rain', v))!
    expect(hex(pixelAt(field, 0.02, 0.5))).toBe(RAIN_BANDS.find((b) => b.min === 2)!.color)
    // The east column has no data: it takes the loaded neighbours' value (0 mm), which is clear.
    expect(pixelAt(field, 0.98, 0.5)[3]).toBe(0)
  })

  it('draws nothing without any values', () => {
    expect(renderField(POINTS, 1, 1, () => null, (v) => bandFor('temperature', v))).toBeNull()
    expect(renderField([], 1, 1, () => 1, (v) => bandFor('temperature', v))).toBeNull()
  })
})
