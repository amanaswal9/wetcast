import { useState } from 'react'
import { Button, GroupBox } from '../../components/retro'
import type { Theme } from '../../hooks/useTheme'
import { hhmm, round } from '../../lib/format'
import type { Forecast, HourlyPoint } from '../../types/weather'
import { HourlyTabs } from '../charts/HourlyTabs'

function HourlyTable({ hourly }: { hourly: HourlyPoint[] }) {
  return (
    <div className="r-sunken max-h-[260px] overflow-auto">
      <table className="r-table">
        <caption className="sr-only">Hourly weather, past 12 hours and next 24 hours</caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Temp</th>
            <th scope="col">Rain chance</th>
            <th scope="col">Wind</th>
            <th scope="col">Type</th>
          </tr>
        </thead>
        <tbody>
          {hourly.map((h) => (
            <tr key={h.time}>
              <td>{hhmm(h.time)}</td>
              <td>{h.temperature === null ? 'n/a' : `${round(h.temperature)}°C`}</td>
              <td>{h.precipitationProbability === null ? 'n/a' : `${h.precipitationProbability}%`}</td>
              <td>{h.windSpeed === null ? 'n/a' : `${round(h.windSpeed)} km/h`}</td>
              <td>{h.isPast ? 'Past' : 'Forecast'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function HourlyPanel({ forecast, theme }: { forecast: Forecast; theme: Theme }) {
  const [asTable, setAsTable] = useState(false)

  return (
    <GroupBox title="Hourly: past 12 hours and next 24">
      <div className="mb-2 flex justify-end">
        <Button aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'Show chart' : 'Show table'}
        </Button>
      </div>
      {asTable ? <HourlyTable hourly={forecast.hourly} /> : <HourlyTabs points={forecast.hourly} theme={theme} />}
    </GroupBox>
  )
}
