/** Fields any hourly series needs to be charted. */
export interface ChartPoint {
  time: string
  isPast: boolean
  temperature: number | null
  precipitationProbability: number | null
  windSpeed: number | null
}

export type Mode = 'temperature' | 'rain' | 'wind'

export const MODES: { id: Mode; label: string; unit: string; pick: (h: ChartPoint) => number | null }[] = [
  { id: 'temperature', label: 'Temperature', unit: '°C', pick: (h) => h.temperature },
  { id: 'rain', label: 'Rain', unit: '%', pick: (h) => h.precipitationProbability },
  { id: 'wind', label: 'Wind', unit: 'km/h', pick: (h) => h.windSpeed },
]

export interface Row {
  time: string
  isPast: boolean
  value: number | null
  past: number | null
  forecast: number | null
}

export function buildRows(points: ChartPoint[], mode: Mode, nowTime: string | null): Row[] {
  const pick = MODES.find((m) => m.id === mode)!.pick
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

/** The last hour at or before the current reading, if it is in the series. */
export function findNowTime(points: ChartPoint[]): string | null {
  for (let i = points.length - 1; i >= 0; i--) if (points[i].isPast) return points[i].time
  return null
}
