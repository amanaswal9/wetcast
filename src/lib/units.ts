import { useMemo, useSyncExternalStore } from 'react'
import { dateFormatter } from './format'

// Display units, chosen by the viewer and kept in this browser. Data stays metric everywhere
// (Open-Meteo, the models, the API); only what is shown on screen is converted. Model test
// scores (MAE) stay metric because that is how they were measured and published.
export type TempUnit = 'c' | 'f'
export type SpeedUnit = 'kmh' | 'mph'
export type ClockUnit = '24' | '12'

export interface Units {
  temp: TempUnit
  speed: SpeedUnit
  clock: ClockUnit
}

const KEY = 'weatherai.units'

// First visit: follow the browser's region (the US uses °F, mph and a 12-hour clock).
export function defaultUnits(language: string = typeof navigator === 'undefined' ? 'en-GB' : navigator.language): Units {
  const us = /-US$/i.test(language)
  return { temp: us ? 'f' : 'c', speed: us ? 'mph' : 'kmh', clock: us ? '12' : '24' }
}

function load(): Units {
  const fallback = defaultUnits()
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Units> | null
    if (!saved) return fallback
    return {
      temp: saved.temp === 'f' || saved.temp === 'c' ? saved.temp : fallback.temp,
      speed: saved.speed === 'mph' || saved.speed === 'kmh' ? saved.speed : fallback.speed,
      clock: saved.clock === '12' || saved.clock === '24' ? saved.clock : fallback.clock,
    }
  } catch {
    return fallback
  }
}

let current: Units = load()
const listeners = new Set<() => void>()

// Current units, read outside React.
export function getUnits(): Units {
  return current
}

// Change the units, save them and tell every component using them.
export function setUnits(next: Units): void {
  current = { ...next }
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    // Private mode or storage blocked: the choice lasts until the page is closed.
  }
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Current units in a component; re-renders when they change.
export function useUnits(): Units {
  return useSyncExternalStore(subscribe, getUnits, getUnits)
}

function roundNum(value: number): number {
  const r = Math.round(value)
  return Object.is(r, -0) ? 0 : r
}

// Kilometres per hour in one mile per hour.
export const KMH_PER_MPH = 1.609344

// Converters and formatters for one choice of units. Inputs are always °C, km/h and "HH:MM".
export function makeFormat(units: Units) {
  const f = units.temp === 'f'
  const mph = units.speed === 'mph'
  const twelve = units.clock === '12'

  const temp = (c: number) => (f ? (c * 9) / 5 + 32 : c)
  const speed = (kmh: number) => (mph ? kmh / KMH_PER_MPH : kmh)

  // "13:15" (or an ISO local string) -> "13:15" or "1:15 pm".
  const time = (value: string) => {
    const hm = value.length > 5 ? value.slice(11, 16) : value
    if (!twelve) return hm
    const [h, m] = hm.split(':').map(Number)
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`
  }

  return {
    units,
    tempUnit: f ? '°F' : '°C',
    speedUnit: mph ? 'mph' : 'km/h',
    // °C -> the chosen scale, unrounded (charts).
    temp,
    // A temperature difference (no +32 offset), e.g. an error range.
    tempDelta: (c: number) => (f ? (c * 9) / 5 : c),
    speed,
    // "21°C" / "70°F"
    t: (c: number) => `${roundNum(temp(c))}°${f ? 'F' : 'C'}`,
    // "21°" (where the unit is already clear)
    deg: (c: number) => `${roundNum(temp(c))}°`,
    // "12 km/h" / "7 mph"
    s: (kmh: number) => `${roundNum(speed(kmh))} ${mph ? 'mph' : 'km/h'}`,
    time,
    // Chart axis label for a whole hour: "13:00" or "1 pm".
    hourTick: (value: string) => {
      if (!twelve) return value.length > 5 ? value.slice(11, 16) : value
      const h = Number((value.length > 5 ? value.slice(11, 16) : value).slice(0, 2))
      return `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`
    },
    // Options for toLocaleString/toLocaleTimeString so viewer-clock times follow the choice.
    hour12: twelve,
    // The viewer's own clock time ("updated at", taskbar).
    clock: (date: Date) => dateFormatter(undefined, { hour: '2-digit', minute: '2-digit', hour12: twelve }).format(date),
  }
}

export type Format = ReturnType<typeof makeFormat>

// Formatters for the viewer's current units.
export function useFormat(): Format {
  const units = useUnits()
  return useMemo(() => makeFormat(units), [units])
}
