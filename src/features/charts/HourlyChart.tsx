import { Chart, type Series } from '../../components/chart/Chart'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import type { ChartColors } from '../../lib/chartTheme'
import { round } from '../../lib/format'
import { useFormat } from '../../lib/units'

import type { Mode, Row } from './series'

function ChartTooltip({ row, unit }: { row: Row; unit: string }) {
  const fmt = useFormat()
  if (row.value === null) return null
  return (
    <div className="r-tooltip tabular-nums">
      <div>
        {fmt.time(row.time)}, {row.isPast ? 'past hour (model estimate)' : 'Open-Meteo forecast'}
      </div>
      <div className="font-bold">
        {round(row.value)} {unit}
      </div>
    </div>
  )
}

// Legend under the hourly chart. Line samples match the chart, so it works without colour.
export function ChartLegend({ colors, mode, showPast }: { colors: ChartColors; mode: Mode; showPast: boolean }) {
  const isBars = mode === 'rain'
  return (
    <ul className="m-0 mt-2 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[0.92em]">
      {showPast && (
        <li className="flex items-center gap-1.5">
          <svg width="22" height="10" aria-hidden="true">
            {isBars ? <rect x="6" y="0" width="10" height="10" fill={colors.barPast} /> : <line x1="0" y1="5" x2="22" y2="5" stroke={colors.past} strokeWidth="2" />}
          </svg>
          Past hours (Open-Meteo estimate)
        </li>
      )}
      <li className="flex items-center gap-1.5">
        <svg width="22" height="10" aria-hidden="true">
          {isBars ? (
            <rect x="6" y="0" width="10" height="10" fill={colors.barForecast} />
          ) : (
            <line x1="0" y1="5" x2="22" y2="5" stroke={colors.forecast} strokeWidth="2" strokeDasharray="5 3" />
          )}
        </svg>
        Open-Meteo forecast
      </li>
      <li className="text-[var(--text-muted)]">
        Wetcast&apos;s own predictions are on the <a href="#/forecast" className="text-[inherit]">Forecast page</a>, kept separate from this data.
      </li>
    </ul>
  )
}

interface HourlyChartProps {
  rows: Row[]
  mode: Mode
  unit: string
  colors: ChartColors
  nowTime: string | null
}

// "Lowest 14 °C at 06:00, highest 24 °C at 15:00." (or the busiest hour for rain)
function summarise(rows: Row[], mode: Mode, unit: string, time: (t: string) => string): string | undefined {
  const known = rows.filter((r): r is Row & { value: number } => r.value !== null)
  if (known.length === 0) return undefined
  const low = known.reduce((a, b) => (b.value < a.value ? b : a))
  const high = known.reduce((a, b) => (b.value > a.value ? b : a))
  const span = `From ${time(known[0].time)} to ${time(known[known.length - 1].time)}.`
  if (mode === 'rain') return `${span} Highest chance of rain ${round(high.value)}% at ${time(high.time)}.`
  return `${span} Lowest ${round(low.value)} ${unit} at ${time(low.time)}, highest ${round(high.value)} ${unit} at ${time(high.time)}.`
}

// Hourly chart for one quantity, with a marker at the current hour.
export function HourlyChart({ rows, mode, unit, colors, nowTime }: HourlyChartProps) {
  const wide = useMediaQuery('(min-width: 640px)')
  const fmt = useFormat()
  const step = wide ? 3 : 6
  const xTicks = rows.flatMap((r, i) => (Number(r.time.slice(11, 13)) % step === 0 ? [{ at: i, label: fmt.hourTick(r.time) }] : []))
  const nowIndex = nowTime ? rows.findIndex((r) => r.time === nowTime) : -1
  const series: Series<Row>[] =
    mode === 'rain'
      ? [
          { type: 'bars', key: 'past', value: (r) => r.past, color: colors.barPast, stack: 'rain' },
          { type: 'bars', key: 'forecast', value: (r) => r.forecast, color: colors.barForecast, stack: 'rain' },
        ]
      : [
          { type: 'line', key: 'past', value: (r) => r.past, color: colors.past },
          { type: 'line', key: 'forecast', value: (r) => r.forecast, color: colors.forecast, dash: '6 4' },
        ]
  return (
    <Chart
      rows={rows}
      series={series}
      colors={colors}
      height={wide ? 260 : 220}
      top={16}
      xTicks={xTicks}
      y={{ domain: mode === 'rain' ? [0, 100] : ['auto', 'auto'], format: (v) => `${round(v)}${mode === 'temperature' ? '°' : ''}` }}
      markers={nowIndex >= 0 ? [{ at: nowIndex, label: 'Now' }] : []}
      barGap={0.08}
      tooltip={(row) => <ChartTooltip row={row} unit={unit} />}
      label={`${mode === 'temperature' ? 'Temperature' : mode === 'rain' ? 'Chance of rain' : 'Wind'} by hour`}
      summary={summarise(rows, mode, unit, fmt.time)}
    />
  )
}
