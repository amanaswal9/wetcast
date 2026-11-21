import outlineFile from '../../public/map-outline.json?raw'
import { describe, expect, it } from 'vitest'
import { decodeOutline, decodeRing } from './mapOutline'

describe('map outline', () => {
  it('turns whole-number steps back into degrees', () => {
    expect(decodeRing([2863, 7721, 10, -5, -10, 5])).toEqual([
      [28.63, 77.21],
      [28.73, 77.16],
      [28.63, 77.21],
    ])
  })

  it('rejects a file in the wrong format', () => {
    expect(() => decodeOutline({ countries: [] })).toThrow(/expected format/)
  })

  it('ships a world outline in which India sits where it should', () => {
    const rings = decodeOutline(JSON.parse(outlineFile))
    expect(rings.length).toBeGreaterThan(500)
    // Every point is a real latitude and longitude.
    for (const ring of rings) for (const [lat, lon] of ring) expect(Math.abs(lat) <= 90 && Math.abs(lon) <= 180).toBe(true)
    // Some ring surrounds Delhi (ray casting).
    const inside = (ring: [number, number][], lat: number, lon: number) => {
      let hit = false
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [ai, oi] = ring[i]
        const [aj, oj] = ring[j]
        if (ai > lat !== aj > lat && lon < ((oj - oi) * (lat - ai)) / (aj - ai) + oi) hit = !hit
      }
      return hit
    }
    expect(rings.some((r) => inside(r, 28.61, 77.21))).toBe(true)
    // ...and none covers the middle of the Arabian Sea.
    expect(rings.some((r) => inside(r, 15, 65))).toBe(false)
  })
})
