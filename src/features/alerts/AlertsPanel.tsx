import type { ReactNode } from 'react'
import { MessageBox } from '../../components/retro'
import { useResource } from '../../hooks/useResource'
import { getAlerts, type AlertsResult, type OfficialAlert } from '../../lib/api/weatherai'
import { dateFormatter } from '../../lib/format'
import { getUnits } from '../../lib/units'
import type { Place } from '../../types/weather'

const REFRESH_MS = 10 * 60_000

function when(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return dateFormatter(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: getUnits().clock === '12' }).format(date)
}

function clock(iso: string | null | undefined): string {
  return iso ? dateFormatter(undefined, { hour: '2-digit', minute: '2-digit', hour12: getUnits().clock === '12' }).format(new Date(iso)) : 'never'
}

const fieldStyle = { whiteSpace: 'normal', overflow: 'visible', textOverflow: 'clip', height: 'auto' } as const

// A short status in the same sunken style as the status bar. On phones it is one line
// (`short`) that opens to the full text, so it doesn't push the weather down; wider
// screens show the full text. Either way it keeps the same height while checking and
// when done, so the weather below doesn't jump when the answer arrives.
function StatusLine({ short, children }: { short?: string; children: ReactNode }) {
  if (!short) {
    return (
      <p className="r-status-field m-0 min-h-[1.6em] text-[0.92em]" style={fieldStyle} role="status">
        {children}
      </p>
    )
  }
  return (
    <div role="status" className="text-[0.92em]">
      <details className="r-status-field r-chip sm:hidden" style={fieldStyle}>
        <summary>{short}</summary>
        <p className="m-0 mt-1">{children}</p>
      </details>
      <p className="r-status-field m-0 hidden min-h-[1.6em] sm:block" style={fieldStyle}>
        {children}
      </p>
    </div>
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
            . Shown as issued; Wetcast does not change or add to official warnings.
          </p>
        </MessageBox>
      </div>
    )
  }
  if (result.coverage === 'none') {
    return <StatusLine short="Official warnings: not available here">Official warnings aren't available for this country in Wetcast yet. Check your national weather service.</StatusLine>
  }
  if (result.stale) {
    return (
      <StatusLine short="Official warnings: couldn't check recently">
        Official warnings: couldn't check {source?.name ?? 'the official feed'} recently (last checked {clock(result.feed_checked_at)}).{' '}
        {result.error ?? ''} Check your national or state weather service.
      </StatusLine>
    )
  }
  return (
    <StatusLine short={
        // The "not a complete record" caveat stays visible even when the line is closed.
        result.coverage === 'india' ? 'No warnings found: not a complete record' : `No official warnings, checked ${clock(result.feed_checked_at)}`
      }>
      No official warnings here from {result.coverage === 'india' ? 'NDMA Sachet (IMD)' : source?.name}, checked {clock(result.feed_checked_at)}.
      {result.coverage === 'india' && ' Not a complete record: check IMD if the weather looks dangerous.'}
    </StatusLine>
  )
}

// Official weather warnings for the place, refreshed every ten minutes.
export function AlertsPanel({ place }: { place: Place }) {
  const key = `alerts:${place.latitude.toFixed(3)},${place.longitude.toFixed(3)}:${place.countryCode ?? ''}`
  const result = useResource(key, ({ signal }) => getAlerts(place.latitude, place.longitude, place.countryCode, signal), REFRESH_MS)
  if (!result.data) {
    if (result.status === 'error') return <StatusLine short="Official warnings: unavailable right now">Official warnings: unavailable right now (Wetcast's server isn't reachable).</StatusLine>
    return <StatusLine>Official warnings: checking…</StatusLine>
  }
  return (
    <section aria-label="Official weather warnings">
      <Body result={result.data} />
    </section>
  )
}
