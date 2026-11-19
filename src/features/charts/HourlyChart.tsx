import { useReducedMotion } from 'motion/react'
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { CHART_FONT, type ChartColors } from '../../lib/chartTheme'
import { hhmm, round } from '../../lib/format'

import type { Mode, Row } from './series'

interface ChartTooltipProps {
  active?: boolean
  payload?: TooltipContentProps['payload']
  unit: string
}

function ChartTooltip({ active, payload, unit }: ChartTooltipProps) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload as Row | undefined
  if (!row || row.value === null) return null
  return (
    <div className="r-tooltip tabular-nums">
      <div>
        {hhmm(row.time)}, {row.isPast ? 'past hour (model estimate)' : 'Open-Meteo forecast'}
      </div>
      <div className="font-bold">
        {round(row.value)} {unit}
      </div>
    </div>
  )
}

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
        WeatherAI&apos;s own predictions are on the <a href="#/forecast" className="text-[inherit]">Forecast page</a>, kept separate from this data.
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

export function HourlyChart({ rows, mode, unit, colors, nowTime }: HourlyChartProps) {
  const reduceMotion = useReducedMotion()
  const wide = useMediaQuery('(min-width: 640px)')
  const step = wide ? 3 : 6
  const ticks = rows.filter((r) => Number(r.time.slice(11, 13)) % step === 0).map((r) => r.time)
  const animate = !reduceMotion
  const tick = { fill: colors.text, fontSize: 11, fontFamily: CHART_FONT }

  return (
    <ResponsiveContainer width="100%" height={wide ? 260 : 220}>
      <ComposedChart data={rows} margin={{ top: 16, right: 8, left: 0, bottom: 0 }} barCategoryGap={1}>
        <CartesianGrid stroke={colors.grid} vertical={false} />
        <XAxis
          dataKey="time"
          ticks={ticks}
          interval={0}
          tickFormatter={hhmm}
          tick={tick}
          tickLine={{ stroke: colors.axis }}
          axisLine={{ stroke: colors.axis }}
        />
        <YAxis
          width={44}
          tick={tick}
          tickLine={false}
          axisLine={{ stroke: colors.axis }}
          tickFormatter={(v: number) => `${round(v)}${mode === 'temperature' ? '°' : ''}`}
          domain={mode === 'rain' ? [0, 100] : ['auto', 'auto']}
          allowDecimals={false}
        />
        <Tooltip
          content={(props) => <ChartTooltip active={props.active} payload={props.payload} unit={unit} />}
          cursor={{ stroke: colors.axis, strokeDasharray: '2 2' }}
          isAnimationActive={false}
        />
        {mode === 'rain' ? (
          <>
            <Bar dataKey="past" stackId="rain" fill={colors.barPast} isAnimationActive={animate} animationDuration={400} />
            <Bar dataKey="forecast" stackId="rain" fill={colors.barForecast} isAnimationActive={animate} animationDuration={400} />
          </>
        ) : (
          <>
            <Line
              dataKey="past"
              type="monotone"
              stroke={colors.past}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3, fill: colors.past, stroke: colors.past }}
              isAnimationActive={animate}
              animationDuration={400}
              connectNulls={false}
            />
            <Line
              dataKey="forecast"
              type="monotone"
              stroke={colors.forecast}
              strokeWidth={2}
              strokeDasharray="6 4"
              dot={false}
              activeDot={{ r: 3, fill: colors.forecast, stroke: colors.forecast }}
              isAnimationActive={animate}
              animationDuration={400}
              connectNulls={false}
            />
          </>
        )}
        {nowTime && (
          <ReferenceLine
            x={nowTime}
            stroke={colors.text}
            strokeDasharray="1 3"
            label={{ value: 'Now', position: 'top', fill: colors.text, fontSize: 11, fontFamily: CHART_FONT }}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  )
}
