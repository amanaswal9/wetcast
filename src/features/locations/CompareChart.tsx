import { useReducedMotion } from 'motion/react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import type { Theme } from '../../hooks/useTheme'
import { CHART_COLORS, CHART_FONT, CITY_COLORS, CITY_DASHES } from '../../lib/chartTheme'
import { round } from '../../lib/format'
import type { Forecast, Place } from '../../types/weather'

export interface CompareSeries {
  place: Place
  forecast: Forecast
}

/**
 * Next 24 hours of temperature from "now" in each city. Cities sit in
 * different time zones, so the x-axis is hours from now, not clock time.
 */
function next24(forecast: Forecast): (number | null)[] {
  const firstFuture = forecast.hourly.findIndex((h) => !h.isPast)
  const start = firstFuture > 0 ? firstFuture - 1 : 0
  return forecast.hourly.slice(start, start + 25).map((h) => h.temperature)
}

function offsetLabel(offset: number): string {
  return offset === 0 ? 'Now' : `+${offset} h`
}

interface TooltipProps {
  active?: boolean
  payload?: TooltipContentProps['payload']
  label?: unknown
  names: string[]
}

function CompareTooltip({ active, payload, label, names }: TooltipProps) {
  if (!active || !payload?.length) return null
  return (
    <div className="r-tooltip tabular-nums">
      <div>{offsetLabel(Number(label))}</div>
      {payload.map((entry, i) => {
        const index = Number(String(entry.dataKey).slice(1))
        return typeof entry.value === 'number' ? (
          <div key={i}>
            {names[index]}: <b>{round(entry.value)}°C</b>
          </div>
        ) : null
      })}
    </div>
  )
}

export function CompareChart({ series, theme }: { series: CompareSeries[]; theme: Theme }) {
  const reduceMotion = useReducedMotion()
  const wide = useMediaQuery('(min-width: 640px)')
  const colors = CHART_COLORS[theme]
  const cityColors = CITY_COLORS[theme]
  const values = series.map((s) => next24(s.forecast))
  const names = series.map((s) => s.place.name)
  const rows = Array.from({ length: 25 }, (_, offset) => {
    const row: Record<string, number | null> = { offset }
    values.forEach((list, i) => {
      row[`c${i}`] = list[offset] ?? null
    })
    return row
  })
  const tick = { fill: colors.text, fontSize: 11, fontFamily: CHART_FONT }
  const ticks = wide ? [0, 3, 6, 9, 12, 15, 18, 21, 24] : [0, 6, 12, 18, 24]

  return (
    <figure className="m-0">
      <div className="r-sunken p-1">
        <ResponsiveContainer width="100%" height={wide ? 260 : 220}>
          <LineChart data={rows} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={colors.grid} vertical={false} />
            <XAxis
              dataKey="offset"
              type="number"
              domain={[0, 24]}
              ticks={ticks}
              tickFormatter={offsetLabel}
              tick={tick}
              tickLine={{ stroke: colors.axis }}
              axisLine={{ stroke: colors.axis }}
            />
            <YAxis
              width={44}
              tick={tick}
              tickLine={false}
              axisLine={{ stroke: colors.axis }}
              tickFormatter={(v: number) => `${round(v)}°`}
              domain={['auto', 'auto']}
              allowDecimals={false}
            />
            <Tooltip
              content={(props) => <CompareTooltip active={props.active} payload={props.payload} label={props.label} names={names} />}
              cursor={{ stroke: colors.axis, strokeDasharray: '2 2' }}
              isAnimationActive={false}
            />
            {series.map((s, i) => (
              <Line
                key={s.place.id}
                dataKey={`c${i}`}
                name={s.place.name}
                type="monotone"
                stroke={cityColors[i]}
                strokeWidth={2}
                strokeDasharray={CITY_DASHES[i]}
                dot={false}
                activeDot={{ r: 3, fill: cityColors[i], stroke: cityColors[i] }}
                isAnimationActive={!reduceMotion}
                animationDuration={400}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption>
        <ul className="m-0 mt-2 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[0.92em]">
          {series.map((s, i) => (
            <li key={s.place.id} className="flex items-center gap-1.5">
              <svg width="26" height="10" aria-hidden="true">
                <line x1="0" y1="5" x2="26" y2="5" stroke={cityColors[i]} strokeWidth="2" strokeDasharray={CITY_DASHES[i]} />
              </svg>
              {s.place.name}
            </li>
          ))}
        </ul>
        <p className="m-0 mt-1 text-[0.92em] text-[var(--text-muted)]">
          Temperature over the next 24 hours, from Open-Meteo forecasts. Hours count from now in each city.
        </p>
      </figcaption>
    </figure>
  )
}
