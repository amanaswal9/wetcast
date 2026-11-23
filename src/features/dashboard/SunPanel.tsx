import { GroupBox } from '../../components/retro'
import { formatDuration, minutesOfDay } from '../../lib/format'
import { useFormat } from '../../lib/units'
import type { Forecast } from '../../types/weather'

const W = 200
const H = 72
const CX = 100
const BASE = 62
const RX = 88
const RY = 52

// Sunrise, sunset and the sun's position along today's arc.
export function SunPanel({ forecast }: { forecast: Forecast }) {
  const fmt = useFormat()
  const today = forecast.daily[0]
  if (!today?.sunrise || !today.sunset) {
    return (
      <GroupBox title="Sun">
        <p className="m-0">Sunrise and sunset aren't available for this location today.</p>
      </GroupBox>
    )
  }

  const rise = minutesOfDay(today.sunrise)
  const set = minutesOfDay(today.sunset)
  const now = minutesOfDay(forecast.current.time)
  const fraction = set > rise ? (now - rise) / (set - rise) : -1
  const up = fraction >= 0 && fraction <= 1
  const sunX = CX - RX * Math.cos(Math.PI * fraction)
  const sunY = BASE - RY * Math.sin(Math.PI * fraction)

  const position = up
    ? `The sun is up, ${Math.round(fraction * 100)}% of the way through the day.`
    : 'The sun is below the horizon.'

  return (
    <GroupBox title="Sun">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full max-w-[280px]" role="img" aria-label={position}>
        <path
          d={`M${CX - RX} ${BASE} A${RX} ${RY} 0 0 1 ${CX + RX} ${BASE}`}
          fill="none"
          stroke="var(--shadow)"
          strokeDasharray="3 3"
        />
        <rect x="4" y={BASE} width={W - 8} height="2" fill="var(--text)" />
        {up && (
          <g shapeRendering="crispEdges">
            <rect x={sunX - 5} y={sunY - 5} width="10" height="10" fill="#ffd800" stroke="var(--text)" strokeWidth="1" />
          </g>
        )}
      </svg>
      <dl className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-3 tabular-nums">
        <dt>Sunrise</dt>
        <dd className="m-0">{fmt.time(today.sunrise)}</dd>
        <dt>Sunset</dt>
        <dd className="m-0">{fmt.time(today.sunset)}</dd>
        {today.daylightSeconds !== null && (
          <>
            <dt>Daylight</dt>
            <dd className="m-0">{formatDuration(today.daylightSeconds)}</dd>
          </>
        )}
      </dl>
    </GroupBox>
  )
}
