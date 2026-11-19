import { Button, GroupBox, MessageBox, Skeleton } from '../../components/retro'
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

function DashboardSkeleton() {
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]" aria-busy="true">
      <p className="sr-only" role="status">
        Loading weather
      </p>
      <div className="flex min-w-0 flex-col gap-3">
        <GroupBox title="Now">
          <Skeleton height={72} className="w-48" />
          <Skeleton height={14} className="mt-3 w-32" />
          <Skeleton height={14} className="mt-2 w-40" />
        </GroupBox>
        <GroupBox title="Readings">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} height={18} className="mb-1.5" />
          ))}
        </GroupBox>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <GroupBox title="Summary">
          <Skeleton height={48} />
        </GroupBox>
        <GroupBox title="Hourly: past 12 hours and next 24">
          <Skeleton height={260} />
        </GroupBox>
      </div>
    </div>
  )
}

export function Dashboard({ place, forecast, air, summary, theme, speech }: DashboardProps) {
  if (!forecast.data) {
    if (forecast.status === 'error') {
      return (
        <div className="r-sunken" style={{ background: 'var(--face)' }}>
          <MessageBox
            kind="error"
            role="alert"
            title="Couldn't load the weather"
            actions={<Button onClick={forecast.reload}>Try again</Button>}
          >
            {forecast.error?.message}
          </MessageBox>
        </div>
      )
    }
    return <DashboardSkeleton />
  }

  const data = forecast.data
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
      <div className="min-w-0 lg:col-span-2 empty:hidden">
        <AlertsPanel place={place} />
      </div>
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
        <HourlyPanel forecast={data} theme={theme} />
      </div>
    </div>
  )
}
