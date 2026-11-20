import { Chart } from '../../components/chart/Chart'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import type { Theme } from '../../hooks/useTheme'
import { CHART_COLORS, CITY_COLORS, CITY_DASHES } from '../../lib/chartTheme'
import { round } from '../../lib/format'
import { useFormat, type Format } from '../../lib/units'
import type { Forecast, Place } from '../../types/weather'

export interface CompareSeries {
  place: Place
  forecast: Forecast
}

/**
 * Next 24 hours of temperature from "now" in each city. Cities sit in
 * different time zones, so the x-axis is hours from now, not clock time.
 */
function next24(forecast: Forecast, fmt: Format): (number | null)[] {
  const firstFuture = forecast.hourly.findIndex((h) => !h.isPast)
  const start = firstFuture > 0 ? firstFuture - 1 : 0
  return forecast.hourly.slice(start, start + 25).map((h) => (h.temperature === null ? null : fmt.temp(h.temperature)))
}

function offsetLabel(offset: number): string {
  return offset === 0 ? 'Now' : `+${offset} h`
}

type CompareRow = { offset: number; values: (number | null)[] }

function CompareTooltip({ row, names }: { row: CompareRow; names: string[] }) {
  const fmt = useFormat()
  return (
    <div className="r-tooltip tabular-nums">
      <div>{offsetLabel(row.offset)}</div>
      {row.values.map((v, i) =>
        v === null ? null : (
          <div key={i}>
            {names[i]}: <b>
              {round(v)}
              {fmt.tempUnit}
            </b>
          </div>
        ),
      )}
    </div>
  )
}

export function CompareChart({ series, theme }: { series: CompareSeries[]; theme: Theme }) {
  const wide = useMediaQuery('(min-width: 640px)')
  const colors = CHART_COLORS[theme]
  const fmt = useFormat()
  const cityColors = CITY_COLORS[theme]
  const values = series.map((s) => next24(s.forecast, fmt))
  const names = series.map((s) => s.place.name)
  const rows: CompareRow[] = Array.from({ length: 25 }, (_, offset) => ({ offset, values: values.map((list) => list[offset] ?? null) }))
  const ticks = wide ? [0, 3, 6, 9, 12, 15, 18, 21, 24] : [0, 6, 12, 18, 24]

  return (
    <figure className="m-0">
      <div className="r-sunken p-1">
        <Chart
          rows={rows}
          colors={colors}
          height={wide ? 260 : 220}
          top={12}
          x={{ value: (r) => r.offset, domain: [0, 24] }}
          xTicks={ticks.map((t) => ({ at: t, label: offsetLabel(t) }))}
          y={{ format: (v) => `${round(v)}°` }}
          series={series.map((s, i) => ({
            type: 'line' as const,
            key: s.place.id,
            value: (r: CompareRow) => r.values[i],
            color: cityColors[i],
            dash: CITY_DASHES[i] || undefined,
          }))}
          tooltip={(row) => <CompareTooltip row={row} names={names} />}
          label="Temperature over the next 24 hours in each city"
        />
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
