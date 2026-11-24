import { useState } from 'react'
import { Button, GroupBox } from '../../components/retro'
import type { Theme } from '../../hooks/useTheme'
import { useFormat } from '../../lib/units'
import type { Forecast, HourlyPoint } from '../../types/weather'
import { HourlyTabs } from '../charts/HourlyTabs'

// The hourly numbers as a table, for anyone who would rather read than look at a chart.
function HourlyTable({ hourly }: { hourly: HourlyPoint[] }) {
  const fmt = useFormat()
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
              <td>{fmt.time(h.time)}</td>
              <td>{h.temperature === null ? 'n/a' : fmt.t(h.temperature)}</td>
              <td>{h.precipitationProbability === null ? 'n/a' : `${h.precipitationProbability}%`}</td>
              <td>{h.windSpeed === null ? 'n/a' : fmt.s(h.windSpeed)}</td>
              <td>{h.isPast ? 'Past' : 'Forecast'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Hourly box, as a chart or as a table for anyone who prefers numbers.
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
