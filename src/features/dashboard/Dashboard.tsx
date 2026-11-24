import { useDeferredValue } from 'react'
import { Button, ChartSkeleton, ErrorStack, GroupBox, MessageBox, Skeleton } from '../../components/retro'
import type { ResourceState } from '../../hooks/useResource'
import type { Theme } from '../../hooks/useTheme'
import type { AirQuality, Forecast, Place } from '../../types/weather'
import { AlertsPanel } from '../alerts/AlertsPanel'
import { CurrentConditions } from './CurrentConditions'
import { HourlyPanel } from './HourlyPanel'
import { Readings } from './Readings'
import { Summary } from './Summary'
import { SunPanel } from './SunPanel'

interface DashboardProps {
  place: Place
  forecast: ResourceState<Forecast> & { reload: () => void }
  air: ResourceState<AirQuality>
  summary: string | null
  theme: Theme
  speech: { supported: boolean; speaking: boolean; speak: (text: string) => void; stop: () => void }
}

// Stand-ins for the weather columns while the forecast loads. Each box is about as tall as the real
// one (phones first, then the two-column layout), so nothing below jumps when the weather arrives.
function SkeletonColumns() {
  return (
    <>
      <p className="sr-only" role="status">
        Loading weather
      </p>
      <div className="flex min-w-0 flex-col gap-3">
        <GroupBox title="Now">
          <div className="min-h-[190px] lg:min-h-[185px]">
            <Skeleton height={72} className="w-48" />
            <Skeleton height={14} className="mt-3 w-32" />
            <Skeleton height={14} className="mt-2 w-40" />
          </div>
        </GroupBox>
        <GroupBox title="Readings">
          <div className="min-h-[237px] lg:min-h-[216px]">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} height={18} className="mb-1.5" />
            ))}
          </div>
        </GroupBox>
        <GroupBox title="Sun">
          <div className="min-h-[172px] lg:min-h-[162px]">
            <Skeleton height={14} className="w-40" />
            <Skeleton height={14} className="mt-2 w-32" />
          </div>
        </GroupBox>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <GroupBox title="Summary">
          <div className="min-h-[179px] lg:min-h-[79px]">
            <Skeleton height={48} />
          </div>
        </GroupBox>
        <HourlySkeleton />
      </div>
    </>
  )
}

function HourlySkeleton() {
  return (
    <GroupBox title="Hourly: past 12 hours and next 24">
      <div className="min-h-[427px] lg:min-h-[398px]">
        <ChartSkeleton height={260} />
      </div>
    </GroupBox>
  )
}

// Dashboard page. Shows a loading or error state until the forecast arrives.
export function Dashboard({ place, forecast, air, summary, theme, speech }: DashboardProps) {
  // The hourly chart is the slowest part to draw, so it follows a moment after the rest: the
  // current conditions appear as soon as the weather arrives, with the chart's frame held in place.
  const hourly = useDeferredValue(forecast.data)

  if (!forecast.data && forecast.status === 'error') {
    return (
      <ErrorStack caption="Weather" title="Couldn't load the weather" actions={<Button onClick={forecast.reload}>Try again</Button>}>
        {forecast.error?.message}
      </ErrorStack>
    )
  }

  const data = forecast.data
  // The warnings line sits outside the loading switch, so it stays put (and keeps checking)
  // while the weather below loads.
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]" aria-busy={!data}>
      <div className="min-w-0 lg:col-span-2 empty:hidden">
        <AlertsPanel place={place} />
      </div>
      {!data ? (
        <SkeletonColumns />
      ) : (
        <>
          {forecast.status === 'error' && (
            <div className="lg:col-span-2">
              <MessageBox
                kind="warning"
                role="alert"
                title="Showing earlier data"
                actions={<Button onClick={forecast.reload}>Try again</Button>}
              >
                {forecast.error?.message} The readings below are from the last successful update.
              </MessageBox>
            </div>
          )}
          <div className="flex min-w-0 flex-col gap-3">
            <CurrentConditions forecast={data} />
            <Readings forecast={data} air={air} />
            <SunPanel forecast={data} />
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            {summary && <Summary text={summary} speech={speech} />}
            {hourly ? <HourlyPanel forecast={hourly} theme={theme} /> : <HourlySkeleton />}
          </div>
        </>
      )}
    </div>
  )
}
