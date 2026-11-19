import { describe, expect, it } from 'vitest'
import { parseVoiceCommand } from './voice'

describe('parseVoiceCommand', () => {
  it.each([
    ['Weather in Delhi', 'Delhi', null],
    ["What's the forecast for New Delhi tomorrow?", 'New Delhi', 'forecast'],
    ['Will it rain in Mumbai this week', 'Mumbai', 'forecast'],
    ['Lisbon', 'Lisbon', null],
    ['Jaipur weather', 'Jaipur', null],
    ["What's the weather like in New York", 'New York', null],
    ['temperature in San Francisco right now', 'San Francisco', 'dashboard'],
    ['Is it raining in Thiruvananthapuram', 'Thiruvananthapuram', null],
    ['Open the models page', null, 'models'],
    ['show me analytics', null, 'analytics'],
    ['compare my saved places', null, 'locations'],
  ])('%s', (spoken, place, page) => {
    expect(parseVoiceCommand(spoken)).toEqual({ place, page })
  })

  it('handles empty and punctuation-only input', () => {
    expect(parseVoiceCommand('')).toEqual({ place: null, page: null })
    expect(parseVoiceCommand('  ?! ')).toEqual({ place: null, page: null })
  })

  it('does not treat "rain" as the word "in"', () => {
    expect(parseVoiceCommand('rain tomorrow')).toEqual({ place: null, page: 'forecast' })
  })
})
