import type { ReactNode } from 'react'
import { MessageBox } from '../../components/retro'
import { useResource } from '../../hooks/useResource'
import { getAlerts, type AlertsResult, type OfficialAlert } from '../../lib/api/weatherai'
import type { Place } from '../../types/weather'

const REFRESH_MS = 10 * 60_000

function when(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function clock(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : 'never'
}

/** A one-line status in the same sunken style as the status bar. */
function StatusLine({ children }: { children: ReactNode }) {
  return (
    <p className="r-status-field m-0 text-[0.92em]" style={{ whiteSpace: 'normal', overflow: 'visible', textOverflow: 'clip', height: 'auto' }} role="status">
      {children}
    </p>
  )
}

function AlertItem({ alert }: { alert: OfficialAlert }) {
  const until = when(alert.expires)
  const from = when(alert.onset)
  const details = [alert.description, alert.instruction].filter(Boolean)
  return (
    <li className="border-t border-dotted border-[var(--shadow)] pt-2 first:border-t-0 first:pt-0">
      <p className="m-0 font-bold">
        {alert.event ?? 'Warning'}
        {alert.severity && alert.severity !== 'Unknown' && <span className="font-normal"> ({alert.severity.toLowerCase()})</span>}
      </p>
      {alert.headline && <p className="m-0">{alert.headline}</p>}
      <p className="m-0 text-[0.92em] text-[var(--text-muted)]">
        {[alert.area, from && `from ${from}`, until && `until ${until}`, alert.sender && `issued by ${alert.sender}`].filter(Boolean).join(' · ')}
      </p>
      {details.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer">Details and advice</summary>
          {details.map((d) => (
            <p key={d} className="m-0 mt-1 max-w-[75ch] whitespace-pre-line">
              {d}
            </p>
          ))}
        </details>
      )}
    </li>
  )
}

function Body({ result }: { result: AlertsResult }) {
  const source = result.source
  if (result.alerts.length > 0) {
    const worst = result.alerts[0].severity
    const title = `${result.alerts.length === 1 ? 'Official warning' : `${result.alerts.length} official warnings`} for this place`
    return (
      <div className="r-sunken" style={{ background: 'var(--face)' }}>
        <MessageBox kind={worst === 'Extreme' ? 'error' : 'warning'} title={title}>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {result.alerts.map((a, i) => (
              <AlertItem key={a.id ?? i} alert={a} />
            ))}
          </ul>
          <p className="m-0 mt-2 text-[0.92em]">
            Source:{' '}
            {source ? (
              <a href={source.url} target="_blank" rel="noreferrer">
                {source.name}
              </a>
            ) : (
              'official feed'
            )}
            . Shown as issued; WeatherAI does not change or add to official warnings.
          </p>
        </MessageBox>
      </div>
    )
  }
  if (result.coverage === 'none') {
    return <StatusLine>Official warnings: not available for this country in WeatherAI yet. Check your national weather service.</StatusLine>
  }
  if (result.stale) {
    return (
      <StatusLine>
        Official warnings: couldn't check {source?.name ?? 'the official feed'} recently (last checked {clock(result.feed_checked_at)}).{' '}
        {result.error ?? ''} Check your national or state weather service.
      </StatusLine>
    )
  }
  return (
    <StatusLine>
      Official warnings: none in effect for this point from {source?.name}, checked {clock(result.feed_checked_at)}.
      {result.coverage === 'india' && ' The feed isn’t a complete archive; check IMD or your state authority if the weather looks dangerous.'}
    </StatusLine>
  )
}

export function AlertsPanel({ place }: { place: Place }) {
  const key = `alerts:${place.latitude.toFixed(3)},${place.longitude.toFixed(3)}:${place.countryCode ?? ''}`
  const result = useResource(key, ({ signal }) => getAlerts(place.latitude, place.longitude, place.countryCode, signal), REFRESH_MS)
  if (!result.data) {
    if (result.status === 'error') return <StatusLine>Official warnings: unavailable right now (WeatherAI's server isn't reachable).</StatusLine>
    return null
  }
  return (
    <section aria-label="Official weather warnings">
      <Body result={result.data} />
    </section>
  )
}
