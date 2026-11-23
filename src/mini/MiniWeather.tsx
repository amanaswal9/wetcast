import { useEffect, useState } from 'react'
import { PixelWeatherIcon } from '../components/retro'
import { readPlace } from '../hooks/usePlace'
import { useResource } from '../hooks/useResource'
import { getForecast } from '../lib/api/openMeteo'
import { dayName, placeShortLabel, round } from '../lib/format'
import { useFormat } from '../lib/units'
import { describeWeather } from '../lib/weatherCodes'

const MINUTE = 60_000

// How many upcoming hours the strip along the bottom shows.
const NEXT_HOURS = 4

// Wetcast Mini: the weather now and for the next few hours in one small window, for keeping
// on screen like a widget. It shows the place last opened in Wetcast on this device, and
// fetches fresh data every ten minutes and whenever it comes back into view.
export function MiniWeather() {
  // The place can change in the main app while Mini is open, so read it again on focus.
  const [place, setPlace] = useState(readPlace)
  const placeKey = `mini:${place.latitude},${place.longitude}`
  const forecast = useResource(placeKey, ({ signal, fresh }) => getForecast(place, { signal, fresh }), 10 * MINUTE)
  const fmt = useFormat()
  const { reload } = forecast

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'visible') return
      setPlace(readPlace())
      reload()
    }
    document.addEventListener('visibilitychange', refresh)
    const timer = window.setInterval(refresh, 10 * MINUTE)
    return () => {
      document.removeEventListener('visibilitychange', refresh)
      window.clearInterval(timer)
    }
  }, [reload])

  useEffect(() => {
    document.title = `${placeShortLabel(place)}: Wetcast Mini`
  }, [place])

  const data = forecast.data
  const current = data?.current
  const today = data?.daily[0]
  const next = data?.hourly.filter((h) => !h.isPast).slice(0, NEXT_HOURS) ?? []
  const days = data?.daily.slice(1, 4) ?? []

  return (
    <main className="r-window r-mini flex min-h-dvh flex-col">
      <div className="r-title">
        <img src="/favicon.svg" width={16} height={16} alt="" />
        <h1 className="m-0 min-w-0 flex-1 truncate text-[inherit] font-bold">{placeShortLabel(place)}</h1>
        <a className="r-btn r-mini-open" href="/" target="_blank" rel="noopener" title="Open Wetcast">
          <span>Open</span>
        </a>
      </div>

      {forecast.status === 'error' && !data && (
        <p className="m-0 p-3" role="alert">
          Can&apos;t reach the weather service. Check the connection; this updates by itself when it is back.
        </p>
      )}
      {!data && forecast.status !== 'error' && <p className="m-0 p-3">Loading the weather...</p>}

      {current && (
        <div className="flex flex-1 flex-col gap-2 p-2.5">
          <div className="flex items-center gap-3">
            <PixelWeatherIcon code={current.weatherCode} isDay={current.isDay} size={56} className="shrink-0" />
            <p className="r-lcd r-mini-temp m-0 font-pixel leading-none tabular-nums">
              <span className="r-lcd-digits">
                <span className="r-lcd-ghost" aria-hidden="true">
                  {String(round(fmt.temp(current.temperature))).replace(/[0-9-]/g, '8').padStart(2, '8')}
                </span>
                <span>{round(fmt.temp(current.temperature))}</span>
              </span>
              <span className="r-lcd-unit">{fmt.tempUnit}</span>
            </p>
            <div className="min-w-0">
              <p className="m-0 font-bold">{describeWeather(current.weatherCode, current.isDay)}</p>
              {today?.tempMax != null && today.tempMin != null && (
                <p className="m-0 tabular-nums">
                  High {fmt.deg(today.tempMax)}, low {fmt.deg(today.tempMin)}
                </p>
              )}
              <p className="m-0 tabular-nums text-[var(--text-muted)]">
                Rain {today?.precipitationProbabilityMax ?? 0}%, wind {fmt.s(current.windSpeed)}
              </p>
            </div>
          </div>

          {next.length > 0 && (
            <ol className="r-sunken m-0 grid list-none gap-0 p-0" style={{ gridTemplateColumns: `repeat(${next.length}, 1fr)` }} aria-label="Next hours">
              {next.map((h) => (
                <li key={h.time} className="r-mini-hour">
                  <span className="text-[var(--text-muted)]">{fmt.hourTick(h.time)}</span>
                  <span className="font-bold tabular-nums">{h.temperature === null ? 'n/a' : fmt.deg(h.temperature)}</span>
                  <span className="tabular-nums text-[var(--text-muted)]">{h.precipitationProbability ?? 0}% rain</span>
                </li>
              ))}
            </ol>
          )}

          {days.length > 0 && (
            // Only on tall screens (a phone's home-screen app); a small desktop window skips it.
            <ul className="r-mini-days m-0 list-none flex-col gap-1 p-0" aria-label="Next days">
              {days.map((d, i) => (
                <li key={d.date} className="flex items-center gap-2">
                  {d.weatherCode !== null && <PixelWeatherIcon code={d.weatherCode} size={28} className="shrink-0" />}
                  <span className="flex-1">{dayName(d.date, i + 1, 'long')}</span>
                  <span className="tabular-nums">
                    {d.tempMax === null ? 'n/a' : fmt.deg(d.tempMax)} / {d.tempMin === null ? 'n/a' : fmt.deg(d.tempMin)}
                  </span>
                  <span className="w-[5.5em] text-right tabular-nums text-[var(--text-muted)]">{d.precipitationProbabilityMax ?? 0}% rain</span>
                </li>
              ))}
            </ul>
          )}

          <p className="m-0 mt-auto text-[0.92em] text-[var(--text-muted)]">
            Open-Meteo, updated {fmt.clock(new Date(data.fetchedAt))}
          </p>
        </div>
      )}
    </main>
  )
}
