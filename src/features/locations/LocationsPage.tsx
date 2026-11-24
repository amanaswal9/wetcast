import { useEffect, useState } from 'react'
import { Button, ChartSkeleton, DitherPicture, GroupBox, MessageBox, PixelWeatherIcon, Skeleton, TableSkeleton } from '../../components/retro'
import { useForecasts, type PlaceForecast } from '../../hooks/useForecasts'
import { MAX_SAVED, samePlace, type SavedPlaces } from '../../hooks/useSavedPlaces'
import type { Theme } from '../../hooks/useTheme'
import { compass, round } from '../../lib/format'
import { HAS_SERVER } from '../../lib/site'
import { useFormat, type Format } from '../../lib/units'
import { describeWeather } from '../../lib/weatherCodes'
import type { Forecast, Place } from '../../types/weather'
import { CitySearch } from '../search/CitySearch'
import { CompareChart, type CompareSeries } from './CompareChart'

const MAX_COMPARE = 4

function rainNext12(forecast: Forecast): number | null {
  const chances = forecast.hourly
    .filter((h) => !h.isPast)
    .slice(0, 12)
    .map((h) => h.precipitationProbability)
    .filter((p): p is number => p !== null)
  return chances.length > 0 ? Math.max(...chances) : null
}

const METRICS: { label: string; value: (f: Forecast, fmt: Format) => string }[] = [
  { label: 'Local time', value: (f, fmt) => fmt.time(f.current.time) },
  { label: 'Temperature', value: (f, fmt) => fmt.t(f.current.temperature) },
  { label: 'Conditions', value: (f) => describeWeather(f.current.weatherCode, f.current.isDay) },
  { label: 'Feels like', value: (f, fmt) => fmt.t(f.current.apparentTemperature) },
  {
    label: 'Today',
    value: (f, fmt) => {
      const d = f.daily[0]
      return d && d.tempMax !== null && d.tempMin !== null ? `${fmt.deg(d.tempMax)} / ${fmt.deg(d.tempMin)}` : 'n/a'
    },
  },
  {
    label: 'Rain, next 12 h',
    value: (f) => {
      const p = rainNext12(f)
      if (p === null) return 'n/a'
      return p === 0 ? '0%' : `up to ${p}%`
    },
  },
  { label: 'Wind', value: (f, fmt) => `${fmt.s(f.current.windSpeed)} ${compass(f.current.windDirection)}` },
  { label: 'Humidity', value: (f) => `${round(f.current.humidity)}%` },
  { label: 'Pressure', value: (f) => `${round(f.current.pressure)} hPa` },
]

function CurrentCell({ entry, loading }: { entry: PlaceForecast | undefined; loading: boolean }) {
  const fmt = useFormat()
  if (!entry) return loading ? <Skeleton height={16} className="w-28" /> : <span>n/a</span>
  if (!entry.forecast) return <span className="text-[var(--danger)]">Couldn&apos;t load</span>
  const c = entry.forecast.current
  return (
    <span className="flex items-center gap-2 tabular-nums">
      <PixelWeatherIcon code={c.weatherCode} isDay={c.isDay} size={24} />
      <span>
        <b>{fmt.t(c.temperature)}</b> {describeWeather(c.weatherCode, c.isDay).toLowerCase()}
      </span>
    </span>
  )
}

interface LocationsPageProps {
  place: Place
  saved: SavedPlaces
  theme: Theme
  refreshToken: number
  onOpen: (place: Place) => void
}

// Locations page: saved places, the home place and the comparison chart.
export function LocationsPage({ place, saved, theme, refreshToken, onOpen }: LocationsPageProps) {
  const fmt = useFormat()
  const forecasts = useForecasts(saved.places)
  const { reload } = forecasts
  const [message, setMessage] = useState<string | null>(null)
  const [picked, setPicked] = useState<string[] | null>(null)

  useEffect(() => {
    if (refreshToken > 0) reload()
  }, [refreshToken, reload])

  // Default comparison: the first three saved places.
  const compareIds = (picked ?? saved.places.slice(0, 3).map((p) => p.id)).filter((id) => saved.places.some((p) => p.id === id))
  const loading = forecasts.status === 'loading' || forecasts.refreshing
  const byId = new Map((forecasts.data ?? []).map((e) => [e.place.id, e]))

  function add(next: Place) {
    const result = saved.add(next)
    setMessage(
      result === 'added'
        ? `${next.name} saved.`
        : result === 'exists'
          ? `${next.name} is already saved.`
          : `You can save up to ${MAX_SAVED} places. Remove one to add ${next.name}.`,
    )
  }

  function toggleCompare(id: string) {
    if (compareIds.includes(id)) {
      setPicked(compareIds.filter((x) => x !== id))
      setMessage(null)
    } else if (compareIds.length >= MAX_COMPARE) {
      setMessage(`Compare up to ${MAX_COMPARE} places at once. Untick one first.`)
    } else {
      setPicked([...compareIds, id])
      setMessage(null)
    }
  }

  const compared = compareIds
    .map((id) => byId.get(id))
    .filter((e): e is PlaceForecast => e !== undefined && e.forecast !== null)
    .map((e): CompareSeries => ({ place: e.place, forecast: e.forecast! }))

  const currentSaved = saved.isSaved(place)

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <GroupBox title={`Saved places (${saved.places.length} of ${MAX_SAVED})`}>
        <div className="flex flex-wrap items-center gap-1.5">
          <CitySearch onSelect={add} label="Search for a city to save" placeholder="Add a city" />
          {!currentSaved && <Button onClick={() => add(place)}>Save {place.name}</Button>}
        </div>
        <p role="status" className={message ? 'm-0 mt-2' : 'sr-only'}>
          {message}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[0.92em]">
          <span className="r-status-field">
            {saved.syncStatus === 'synced' && 'Saved on the Wetcast server'}
            {saved.syncStatus === 'saving' && 'Saving…'}
            {saved.syncStatus === 'connecting' && 'Connecting to the server…'}
            {saved.syncStatus === 'offline' && 'Saved in this browser only'}
            {saved.syncStatus === 'rejected' && 'Not saved on the server'}
          </span>
          {saved.syncStatus === 'rejected' && (
            <>
              <span className="text-[var(--text-muted)]">The server refused this list. It&apos;s still kept in this browser.</span>
              <Button onClick={saved.retrySync}>Try again</Button>
            </>
          )}
          {saved.syncStatus === 'offline' && !HAS_SERVER && (
            <span className="text-[var(--text-muted)]">This public copy has no server, so saved places stay in this browser.</span>
          )}
          {saved.syncStatus === 'offline' && HAS_SERVER && (
            <>
              <span className="text-[var(--text-muted)]">The server isn&apos;t reachable. Changes will sync when it&apos;s back.</span>
              <Button onClick={saved.retrySync}>Try again</Button>
            </>
          )}
          {saved.syncStatus === 'synced' && (
            <span className="text-[var(--text-muted)]">Filed under an anonymous ID for this browser; no account needed.</span>
          )}
        </div>

        {saved.places.length === 0 ? (
          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-start">
            <DitherPicture caption="No places saved" />
            <MessageBox kind="info" title="Save the places you check most">
              <p className="m-0">
                Search for a city above to add it. Saved places load together here, can be compared side by side, and
                one can be your home location that Wetcast opens with.
              </p>
            </MessageBox>
          </div>
        ) : (
          <>
            <p className="m-0 mt-3 mb-1">Tick two to four places to compare them.</p>
            <ul className="r-listview">
              {saved.places.map((p) => {
                const isHome = saved.home?.id === p.id
                const isCurrent = samePlace(p, place)
                const detail = [p.admin1 !== p.name ? p.admin1 : undefined, p.country].filter(Boolean).join(', ')
                return (
                  <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-2 py-2">
                    <label className="flex min-w-0 flex-1 basis-[200px] cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        className="r-check"
                        checked={compareIds.includes(p.id)}
                        onChange={() => toggleCompare(p.id)}
                      />
                      <span className="min-w-0">
                        <span className="sr-only">Compare </span>
                        <span className="font-bold">{p.name}</span>
                        {isHome && <span> (home)</span>}
                        {isCurrent && <span className="text-[var(--text-muted)]"> (showing now)</span>}
                        {detail && <span className="block truncate text-[0.92em] text-[var(--text-muted)]">{detail}</span>}
                      </span>
                    </label>
                    <span className="min-w-[150px]">
                      <CurrentCell entry={byId.get(p.id)} loading={loading || forecasts.status === 'idle'} />
                    </span>
                    <span className="flex flex-wrap gap-1.5">
                      <Button onClick={() => onOpen(p)} aria-label={`Open ${p.name} on the Dashboard`}>
                        Open
                      </Button>
                      <Button
                        aria-pressed={isHome}
                        onClick={() => saved.setHome(isHome ? null : p)}
                        aria-label={isHome ? `${p.name} is your home location. Press to unset.` : `Set ${p.name} as home`}
                      >
                        {isHome ? 'Home' : 'Set as home'}
                      </Button>
                      <Button onClick={() => saved.remove(p)} aria-label={`Remove ${p.name}`}>
                        Remove
                      </Button>
                    </span>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </GroupBox>

      {saved.places.length > 0 && (
        <GroupBox title="Compare">
          {forecasts.status === 'error' && !forecasts.data ? (
            <MessageBox kind="error" role="alert" title="Couldn't load your places" actions={<Button onClick={reload}>Try again</Button>}>
              {forecasts.error?.message}
            </MessageBox>
          ) : compareIds.length < 2 ? (
            <p className="m-0">Tick at least two saved places to compare them.</p>
          ) : !forecasts.data ? (
            <div className="flex min-w-0 flex-col gap-3">
              <ChartSkeleton height={260} />
              <TableSkeleton rows={4} columns={Math.min(compareIds.length, 4) + 1} />
            </div>
          ) : (
            <div className="flex min-w-0 flex-col gap-3">
              {compared.length >= 2 && <CompareChart series={compared} theme={theme} />}
              <div className="r-sunken overflow-x-auto">
                <table className="r-table min-w-[440px]">
                  <caption className="sr-only">Current weather in the compared places</caption>
                  <thead>
                    <tr>
                      <th scope="col">
                        <span className="sr-only">Measure</span>
                      </th>
                      {compareIds.map((id) => (
                        <th key={id} scope="col">
                          {byId.get(id)?.place.name ?? 'Unknown'}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {METRICS.map((metric) => (
                      <tr key={metric.label}>
                        <th scope="row">{metric.label}</th>
                        {compareIds.map((id) => {
                          const f = byId.get(id)?.forecast
                          return <td key={id}>{f ? metric.value(f, fmt) : 'Unavailable'}</td>
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="m-0 text-[0.92em] text-[var(--text-muted)]">
                Current values are Open-Meteo model estimates; rain chances are Open-Meteo forecasts.
              </p>
            </div>
          )}
        </GroupBox>
      )}
    </div>
  )
}
