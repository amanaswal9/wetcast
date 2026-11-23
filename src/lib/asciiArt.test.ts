import { describe, expect, it } from 'vitest'
import { centre, skyFor, skylineLines, textBox } from './asciiArt'
import type { WeatherKind } from './weatherCodes'

const KINDS: WeatherKind[] = ['clear', 'partly', 'cloudy', 'fog', 'drizzle', 'rain', 'snow', 'storm', 'unknown']

describe('desktop ASCII art', () => {
  it('has a sky for every kind of weather, by day and by night, never wider than the skyline', () => {
    const width = Math.max(...skylineLines().map((r) => r.length))
    for (const kind of KINDS) {
      for (const isDay of [true, false]) {
        const sky = skyFor(kind, isDay)
        expect(sky.length).toBeGreaterThan(3)
        expect(Math.max(...sky.map((r) => r.length))).toBeLessThanOrEqual(width)
        // The owner asked for no asterisks anywhere: stars are "+" and ".".
        expect(sky.join('')).not.toContain('*')
      }
    }
  })

  it('shows the moon at night and the sun by day', () => {
    expect(skyFor('clear', true).join('\n')).toContain('------')
    expect(skyFor('clear', false).join('\n')).not.toContain('------')
  })

  it('boxes text with every row the same width', () => {
    const box = textBox(['Delhi, India', '18°C   Clear'])
    expect(new Set(box.map((r) => r.length)).size).toBe(1)
    expect(box[1]).toContain('Delhi, India')
  })

  it('centres a drawing, ignoring its own indentation', () => {
    expect(centre(['    ab', '    abcd'], 10)).toEqual(['   ab', '   abcd'])
  })
})
