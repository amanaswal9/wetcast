import { GroupBox, PixelWeatherIcon } from '../../components/retro'
import { round } from '../../lib/format'
import { useFormat } from '../../lib/units'
import { describeWeather } from '../../lib/weatherCodes'
import type { Forecast } from '../../types/weather'

export function CurrentConditions({ forecast }: { forecast: Forecast }) {
  const { current, daily } = forecast
  const today = daily[0]
  const description = describeWeather(current.weatherCode, current.isDay)
  const fmt = useFormat()

  return (
    <GroupBox title="Now">
      <div className="flex items-center gap-4">
        <PixelWeatherIcon code={current.weatherCode} isDay={current.isDay} size={72} className="shrink-0" />
        <p className="m-0 font-pixel text-[64px] leading-none tabular-nums sm:text-[72px]">
          {round(fmt.temp(current.temperature))}
          <span className="text-[0.5em] align-top">{fmt.tempUnit}</span>
        </p>
      </div>
      <p className="m-0 mt-3 text-[1.25em] font-bold">{description}</p>
      <dl className="m-0 mt-1 grid grid-cols-[auto_1fr] gap-x-3 tabular-nums">
        <dt>Feels like</dt>
        <dd className="m-0">{fmt.t(current.apparentTemperature)}</dd>
        {today && today.tempMax !== null && today.tempMin !== null && (
          <>
            <dt>Today</dt>
            <dd className="m-0">
              High {fmt.deg(today.tempMax)}, low {fmt.deg(today.tempMin)}
            </dd>
          </>
        )}
      </dl>
      <p className="m-0 mt-3 text-[0.92em] text-[var(--text-muted)]">
        Open-Meteo model estimate for {fmt.time(current.time)} local time.
      </p>
    </GroupBox>
  )
}
