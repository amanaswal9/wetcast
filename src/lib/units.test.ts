import { describe, expect, it } from 'vitest'
import { bandLabel, BANDS } from './mapScales'
import { defaultUnits, makeFormat } from './units'

const metric = makeFormat({ temp: 'c', speed: 'kmh', clock: '24' })
const imperial = makeFormat({ temp: 'f', speed: 'mph', clock: '12' })

describe('units', () => {
  it('formats metric values unchanged', () => {
    expect(metric.t(21.4)).toBe('21°C')
    expect(metric.s(12.3)).toBe('12 km/h')
    expect(metric.time('2026-11-20T13:05')).toBe('13:05')
    expect(metric.hourTick('2026-11-20T09:00')).toBe('09:00')
  })

  it('converts to Fahrenheit and mph', () => {
    expect(imperial.t(0)).toBe('32°F')
    expect(imperial.t(-40)).toBe('-40°F')
    expect(imperial.t(21)).toBe('70°F')
    expect(imperial.deg(100)).toBe('212°')
    expect(imperial.s(100)).toBe('62 mph')
    // A temperature difference has no +32 offset.
    expect(imperial.tempDelta(1)).toBeCloseTo(1.8)
  })

  it('never shows minus zero', () => {
    expect(metric.t(-0.4)).toBe('0°C')
    expect(imperial.t(-17.9)).toBe('0°F')
  })

  it('uses a 12-hour clock around midnight and noon', () => {
    expect(imperial.time('00:15')).toBe('12:15 am')
    expect(imperial.time('11:59')).toBe('11:59 am')
    expect(imperial.time('12:00')).toBe('12:00 pm')
    expect(imperial.time('2026-11-20T23:30')).toBe('11:30 pm')
    expect(imperial.hourTick('2026-11-20T00:00')).toBe('12 am')
    expect(imperial.hourTick('2026-11-20T15:00')).toBe('3 pm')
  })

  it('defaults to imperial only for US English', () => {
    expect(defaultUnits('en-US')).toEqual({ temp: 'f', speed: 'mph', clock: '12' })
    expect(defaultUnits('en-IN')).toEqual({ temp: 'c', speed: 'kmh', clock: '24' })
    expect(defaultUnits('en-GB')).toEqual({ temp: 'c', speed: 'kmh', clock: '24' })
  })
})

describe('map legend labels', () => {
  const same = (v: number) => v

  it('match the original metric labels exactly', () => {
    for (const layer of ['temperature', 'wind', 'rain'] as const) {
      BANDS[layer].forEach((band, i) => expect(bandLabel(layer, i, same)).toBe(band.label))
    }
  })

  it('convert limits but keep notes', () => {
    expect(bandLabel('temperature', 0, imperial.temp)).toBe('below −4')
    expect(bandLabel('temperature', 3, imperial.temp)).toBe('32 to 41')
    expect(bandLabel('wind', 0, imperial.speed)).toBe('below 6 (light)')
    expect(bandLabel('wind', 4, imperial.speed)).toBe('37 and above (gale)')
  })
})
