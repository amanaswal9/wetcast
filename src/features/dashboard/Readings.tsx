import type { ReactNode } from 'react'
import { GroupBox, ProgressBar, Skeleton } from '../../components/retro'
import type { ResourceState } from '../../hooks/useResource'
import { aqiCategory, compass, round, uvCategory } from '../../lib/format'
import type { AirQuality, Forecast } from '../../types/weather'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="whitespace-nowrap">{label}</dt>
      <dd className="r-sunken m-0 min-w-0 px-1.5 py-0.5 tabular-nums">{children}</dd>
    </>
  )
}

/** Arrow pointing where the wind blows to (it comes from `degrees`). */
function WindArrow({ degrees }: { degrees: number }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
      className="mr-1 inline-block align-[-1px]"
      style={{ transform: `rotate(${degrees + 180}deg)` }}
      shapeRendering="crispEdges"
      fill="currentColor"
    >
      <rect x="5" y="3" width="2" height="9" />
      <rect x="4" y="2" width="4" height="2" />
      <rect x="3" y="3" width="6" height="1" />
      <rect x="5" y="0" width="2" height="2" />
    </svg>
  )
}

interface ReadingsProps {
  forecast: Forecast
  air: ResourceState<AirQuality>
}

export function Readings({ forecast, air }: ReadingsProps) {
  const { current, hourly } = forecast
  const nextHour = hourly.find((h) => !h.isPast)
  const rainChance = nextHour?.precipitationProbability ?? null

  let airValue: ReactNode
  if (air.data && air.data.europeanAqi !== null) {
    airValue = `${round(air.data.europeanAqi)}, ${aqiCategory(air.data.europeanAqi).toLowerCase()} (European AQI)`
  } else if (air.status === 'loading' || air.status === 'idle') {
    airValue = <Skeleton height={14} className="my-0.5 w-24" />
  } else {
    airValue = 'Not available here'
  }

  return (
    <GroupBox title="Readings">
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5">
        <Row label="Humidity">{round(current.humidity)}%</Row>
        <Row label="Wind">
          <WindArrow degrees={current.windDirection} />
          {round(current.windSpeed)} km/h from {compass(current.windDirection)}
          {current.windGusts !== null && `, gusts ${round(current.windGusts)}`}
        </Row>
        <Row label="Pressure">{round(current.pressure)} hPa at sea level</Row>
        <Row label="Cloud cover">{round(current.cloudCover)}%</Row>
        <Row label="UV index">
          {current.uvIndex === null ? 'Not available' : `${current.uvIndex.toFixed(1)}, ${uvCategory(current.uvIndex).toLowerCase()}`}
        </Row>
        <Row label="Air quality">{airValue}</Row>
      </dl>
      {rainChance !== null && nextHour && (
        <div className="mt-3">
          <p className="m-0 mb-1">
            Chance of rain in the next hour: <span className="tabular-nums">{rainChance}%</span>
          </p>
          <ProgressBar value={rainChance} label="Chance of rain in the next hour" />
        </div>
      )}
    </GroupBox>
  )
}
