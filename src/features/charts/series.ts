// Fields any hourly series needs to be charted.
export interface ChartPoint {
  time: string
  isPast: boolean
  temperature: number | null
  precipitationProbability: number | null
  windSpeed: number | null
}

import type { Format } from '../../lib/units'

export type Mode = 'temperature' | 'rain' | 'wind'

// The quantities the hourly chart can show, in tab order.
export const MODES: { id: Mode; label: string }[] = [
  { id: 'temperature', label: 'Temperature' },
  { id: 'rain', label: 'Rain' },
  { id: 'wind', label: 'Wind' },
]

// The unit shown for a mode, in the viewer's chosen units.
export function modeUnit(mode: Mode, fmt: Format): string {
  return mode === 'temperature' ? fmt.tempUnit : mode === 'wind' ? fmt.speedUnit : '%'
}

// A point's value for a mode, converted to the viewer's chosen units.
function pickFor(mode: Mode, fmt: Format): (h: ChartPoint) => number | null {
  if (mode === 'temperature') return (h) => (h.temperature === null ? null : fmt.temp(h.temperature))
  if (mode === 'wind') return (h) => (h.windSpeed === null ? null : fmt.speed(h.windSpeed))
  return (h) => h.precipitationProbability
}

export interface Row {
  time: string
  isPast: boolean
  value: number | null
  past: number | null
  forecast: number | null
}

// Chart rows for one mode, converted to the viewer's units.
export function buildRows(points: ChartPoint[], mode: Mode, nowTime: string | null, fmt: Format): Row[] {
  const pick = pickFor(mode, fmt)
  const joinLines = mode !== 'rain'
  return points.map((h) => {
    const value = pick(h)
    return {
      time: h.time,
      isPast: h.isPast,
      value,
      past: h.isPast ? value : null,
      // Lines: the forecast starts at "now" so the two lines join up. Bars must not double-count that hour.
      forecast: !h.isPast || (joinLines && h.time === nowTime) ? value : null,
    }
  })
}

// The last hour at or before the current reading, if it is in the series.
export function findNowTime(points: ChartPoint[]): string | null {
  for (let i = points.length - 1; i >= 0; i--) if (points[i].isPast) return points[i].time
  return null
}
