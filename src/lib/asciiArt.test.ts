import { describe, expect, it } from 'vitest'
import { textBox } from './asciiArt'

describe('desktop note', () => {
  it('boxes text with every row the same width', () => {
    const box = textBox(['Delhi, India', '18°C   Clear'])
    expect(new Set(box.map((r) => r.length)).size).toBe(1)
    expect(box[1]).toContain('Delhi, India')
  })
})
