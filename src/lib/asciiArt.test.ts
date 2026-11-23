import { describe, expect, it } from 'vitest'
import { textBox } from './asciiArt'
import { RONIN_INK, RONIN_LIGHT } from './roninArt'

describe('desktop ASCII art', () => {
  it('boxes text with every row the same width', () => {
    const box = textBox(['Delhi, India', '18°C   Clear'])
    expect(new Set(box.map((r) => r.length)).size).toBe(1)
    expect(box[1]).toContain('Delhi, India')
  })

  it('draws the ronin in two matching versions, without asterisks, at a size that fits the desktop', () => {
    const ink = RONIN_INK.split('\n')
    const light = RONIN_LIGHT.split('\n')
    // Same height, so switching theme doesn't move the figure.
    expect(ink.length).toBe(light.length)
    expect(ink.length).toBeGreaterThan(40)
    for (const rows of [ink, light]) {
      expect(Math.max(...rows.map((r) => r.length))).toBeLessThanOrEqual(110)
      // The owner asked for no asterisks anywhere.
      expect(rows.join('')).not.toContain('*')
    }
  })
})
