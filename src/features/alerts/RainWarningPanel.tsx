import { MessageBox } from '../../components/retro'
import { useResource } from '../../hooks/useResource'
import { getPredictions, type RainWarning } from '../../lib/api/weatherai'
import { coordKey } from '../../lib/format'
import { useFormat } from '../../lib/units'
import type { Place } from '../../types/weather'
import { describeRainWarning, zoneOffsetSeconds } from './rainWarning'

// Wetcast's own rain warning as a message box; nothing when there is none or its hours are past.
export function RainWarningBox({ warning, offsetSeconds }: { warning: RainWarning | null | undefined; offsetSeconds: number }) {
  const fmt = useFormat()
  const text = warning ? describeRainWarning(warning, offsetSeconds, fmt.time) : null
  if (!text) return null
  return (
    <section aria-label="Wetcast rain warning" className="r-sunken" style={{ background: 'var(--face)' }} data-rain-warning={warning?.level}>
      <MessageBox kind={text.kind} title={text.title}>
        <p className="m-0 max-w-[75ch]">{text.body}</p>
        {text.record && <p className="m-0 mt-1 max-w-[75ch] text-[0.92em]">{text.record}</p>}
        <p className="m-0 mt-1 text-[0.92em] text-[var(--text-muted)]">Wetcast's own forecast, not an official warning.</p>
      </MessageBox>
    </section>
  )
}

// The dashboard's rain warning for a place, from the same (shared, cached) predictions the Forecast
// page uses. Shows nothing while loading, on errors, or where the models don't reach.
export function RainWarningPanel({ place, timeZone }: { place: Place; timeZone: string }) {
  const result = useResource(
    `pred:${coordKey(place)}:${place.countryCode ?? ''}`,
    ({ signal }) => getPredictions(place.latitude, place.longitude, signal, false, place.countryCode),
    15 * 60_000,
  )
  const warning = result.data?.kind === 'ok' ? result.data.data.rain_warning : null
  return <RainWarningBox warning={warning} offsetSeconds={zoneOffsetSeconds(timeZone)} />
}
