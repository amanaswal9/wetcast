import { Tabs as TabsRoot, TabsContent, TabsList, TabsTrigger } from '@radix-ui/react-tabs'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button, ChartSkeleton, GroupBox, MessageBox, PixelWeatherIcon, Skeleton } from '../../components/retro'
import { useResource } from '../../hooks/useResource'
import type { Theme } from '../../hooks/useTheme'
import { getWeekForecast } from '../../lib/api/openMeteo'
import { compass, coordKey, dayName, formatDuration, placeShortLabel, shortDate, uvCategory } from '../../lib/format'
import { useFormat } from '../../lib/units'
import { describeWeather } from '../../lib/weatherCodes'
import type { DayDetail, Place, WeekForecast } from '../../types/weather'
import { HourlyTabs } from '../charts/HourlyTabs'
import { ModelPredictionPanel } from './ModelPredictionPanel'

const MINUTE = 60_000

// One labelled figure in a day's details.
function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.92em]">{label}</dt>
      <dd className="r-sunken m-0 mt-0.5 truncate px-1.5 py-0.5 tabular-nums">{children}</dd>
    </div>
  )
}

// A day in the 7-day strip: its icon, high and low, rain chance, and a bar placing its range within the week's.
function DayButton({ day, index, weekMin, weekMax }: { day: DayDetail; index: number; weekMin: number; weekMax: number }) {
  const fmt = useFormat()
  const span = Math.max(1, weekMax - weekMin)
  const hasRange = day.tempMin !== null && day.tempMax !== null
  const left = hasRange ? ((day.tempMin! - weekMin) / span) * 100 : 0
  const width = hasRange ? Math.max(4, ((day.tempMax! - day.tempMin!) / span) * 100) : 0
  // The button's name is its visible text plus a few hidden words ("high", "low", the
  // conditions), so what people see is what voice control and screen readers hear.
  return (
    <TabsTrigger value={day.date} className="r-day shrink-0 snap-start md:w-auto">
      <span className="r-day-name self-start">{dayName(day.date, index, 'short')}</span>
      <span className="text-[0.92em]">
        {shortDate(day.date)}
        {day.weatherCode !== null && <span className="sr-only">, {describeWeather(day.weatherCode).toLowerCase()},</span>}
      </span>
      {day.weatherCode !== null && <PixelWeatherIcon code={day.weatherCode} size={32} className="my-1" />}
      <span className="tabular-nums">
        <span className="sr-only">high </span>
        <span className="font-pixel text-[20px] leading-none">{day.tempMax === null ? '–' : fmt.deg(day.tempMax)}</span>{' '}
        <span className="sr-only">, low </span>
        <span className="text-[var(--text-muted)]">{day.tempMin === null ? '' : fmt.deg(day.tempMin)}</span>
      </span>
      {hasRange && (
        <span className="r-range mt-1" aria-hidden="true">
          <span style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }} />
        </span>
      )}
      <span className="mt-1 text-[0.92em] tabular-nums">
        Rain {day.precipitationProbabilityMax === null ? 'n/a' : `${day.precipitationProbabilityMax}%`}
      </span>
    </TabsTrigger>
  )
}

// The chosen day in full: its figures and its hour-by-hour chart.
function DayDetailPanel({ week, day, index, theme }: { week: WeekForecast; day: DayDetail; index: number; theme: Theme }) {
  const fmt = useFormat()
  const hours = useMemo(() => week.hourly.filter((h) => h.time.startsWith(day.date)), [week.hourly, day.date])

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="m-0 text-[1.15em] font-bold">
        {day.weatherCode === null ? 'Conditions unavailable' : describeWeather(day.weatherCode)}
      </p>
      <dl className="m-0 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="High">{day.tempMax === null ? 'n/a' : fmt.t(day.tempMax)}</Stat>
        <Stat label="Low">{day.tempMin === null ? 'n/a' : fmt.t(day.tempMin)}</Stat>
        <Stat label="Chance of rain">{day.precipitationProbabilityMax === null ? 'n/a' : `${day.precipitationProbabilityMax}%`}</Stat>
        <Stat label="Rain total">{day.precipitationSum === null ? 'n/a' : `${day.precipitationSum.toFixed(1)} mm`}</Stat>
        <Stat label="Wind">
          {day.windSpeedMax === null
            ? 'n/a'
            : `${fmt.s(day.windSpeedMax)}${day.windDirection === null ? '' : ` ${compass(day.windDirection)}`}`}
        </Stat>
        <Stat label="Gusts">{day.windGustsMax === null ? 'n/a' : fmt.s(day.windGustsMax)}</Stat>
        <Stat label="UV index">
          {day.uvIndexMax === null ? 'n/a' : `${day.uvIndexMax.toFixed(1)}, ${uvCategory(day.uvIndexMax).toLowerCase()}`}
        </Stat>
        <Stat label="Sun">
          {day.sunrise && day.sunset ? `${fmt.time(day.sunrise)} to ${fmt.time(day.sunset)}` : 'n/a'}
          {day.daylightSeconds !== null && <span className="sr-only">, {formatDuration(day.daylightSeconds)} of daylight</span>}
        </Stat>
      </dl>
      {hours.length > 0 ? (
        <HourlyTabs key={day.date} points={hours} theme={theme} />
      ) : (
        <p className="m-0">Hourly data isn't available for this day.</p>
      )}
      {index === 0 && (
        <p className="m-0 text-[0.92em] text-[var(--text-muted)]">
          Hours before {fmt.time(week.currentTime)} are Open-Meteo model estimates for time that has already passed.
        </p>
      )}
    </div>
  )
}

// Stand-in while the week loads. It has the real titles, the note under the strip and a detail box
// about as tall as the real one (phones, tablets, desktops), so the page doesn't jump when the week arrives.
function ForecastSkeleton({ place }: { place: Place }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-3">
      <p className="sr-only" role="status">
        Loading the 7-day forecast
      </p>
      <GroupBox title={`Next 7 days in ${placeShortLabel(place)}`} className="r-group-eager">
        <div className="r-day-strip flex min-h-[165px] gap-1 overflow-hidden pb-1 md:grid md:min-h-[156px] md:grid-cols-7">
          {Array.from({ length: 7 }, (_, i) => (
            <Skeleton key={i} height={150} className="shrink-0 md:w-auto" />
          ))}
        </div>
        <p className="m-0 mt-2 text-[0.92em] text-[var(--text-muted)]">
          Open-Meteo forecast. The bar under each day shows its temperature range within the week.
        </p>
      </GroupBox>
      <GroupBox title="Day detail" className="r-group-eager">
        <div className="min-h-[687px] md:min-h-[524px] lg:min-h-[503px]">
          <ChartSkeleton height={300} />
        </div>
      </GroupBox>
    </div>
  )
}

interface ForecastPageProps {
  place: Place
  theme: Theme
  refreshToken: number
  onSelectPlace: (place: Place) => void
}

// Forecast page: a seven-day strip, then the hourly detail and model predictions for the chosen day.
export function ForecastPage({ place, theme, refreshToken, onSelectPlace }: ForecastPageProps) {
  const week = useResource(coordKey(place), ({ signal, fresh }) => getWeekForecast(place, { signal, fresh }), 10 * MINUTE)
  const { reload } = week
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    if (refreshToken > 0) reload()
  }, [refreshToken, reload])

  if (!week.data) {
    if (week.status === 'error') {
      return (
        <div className="r-group">
          <MessageBox kind="error" role="alert" title="Couldn't load the 7-day forecast" actions={<Button onClick={reload}>Try again</Button>}>
            {week.error?.message}
          </MessageBox>
        </div>
      )
    }
    return <ForecastSkeleton place={place} />
  }

  const data = week.data
  const days = data.daily
  const activeDate = selected && days.some((d) => d.date === selected) ? selected : days[0]?.date
  const activeIndex = days.findIndex((d) => d.date === activeDate)
  const temps = days.flatMap((d) => [d.tempMin, d.tempMax]).filter((t): t is number => t !== null)
  const weekMin = Math.min(...temps)
  const weekMax = Math.max(...temps)

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {week.status === 'error' && (
        <MessageBox kind="warning" role="alert" title="Showing earlier data" actions={<Button onClick={reload}>Try again</Button>}>
          {week.error?.message}
        </MessageBox>
      )}
      <TabsRoot value={activeDate} onValueChange={setSelected} className="flex min-w-0 flex-col gap-3">
        <GroupBox title={`Next 7 days in ${placeShortLabel(place)}`} className="r-group-eager">
          <TabsList aria-label="Choose a day" className="r-day-strip flex snap-x gap-1 overflow-x-auto pb-1 md:grid md:grid-cols-7 md:overflow-visible">
            {days.map((day, i) => (
              <DayButton key={day.date} day={day} index={i} weekMin={weekMin} weekMax={weekMax} />
            ))}
          </TabsList>
          <p className="m-0 mt-2 text-[0.92em] text-[var(--text-muted)]">
            Open-Meteo forecast. The bar under each day shows its temperature range within the week.
          </p>
        </GroupBox>
        {days.map((day, i) => (
          <TabsContent key={day.date} value={day.date} className="outline-none">
            <GroupBox title={`${dayName(day.date, i, 'long')}, ${shortDate(day.date)}`} className="r-group-eager">
              <DayDetailPanel week={data} day={day} index={i} theme={theme} />
            </GroupBox>
          </TabsContent>
        ))}
      </TabsRoot>
      <ModelPredictionPanel place={place} week={data} theme={theme} onSelectPlace={onSelectPlace} />
      {activeIndex < 0 && <p className="m-0">No forecast days were returned for this place.</p>}
    </div>
  )
}
