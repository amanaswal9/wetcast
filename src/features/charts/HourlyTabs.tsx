import { useMemo, useState } from 'react'
import { Tab, TabList, TabPanel, Tabs } from '../../components/retro'
import type { Theme } from '../../hooks/useTheme'
import { CHART_COLORS } from '../../lib/chartTheme'
import { ChartLegend, HourlyChart } from './HourlyChart'
import { buildRows, findNowTime, MODES, type ChartPoint, type Mode, type Row } from './series'

/** Temperature / Rain / Wind tabs over one hourly series. Used by Dashboard and Forecast. */
export function HourlyTabs({ points, theme }: { points: ChartPoint[]; theme: Theme }) {
  const [mode, setMode] = useState<Mode>('temperature')
  const colors = CHART_COLORS[theme]
  const nowTime = findNowTime(points)
  // Only mark "Now" when the series also has forecast hours after it.
  const nowMarker = nowTime && points.some((p) => !p.isPast) ? nowTime : null
  const showPast = points.some((p) => p.isPast)

  const rowsByMode = useMemo(
    () => Object.fromEntries(MODES.map((m) => [m.id, buildRows(points, m.id, nowTime)])) as Record<Mode, Row[]>,
    [points, nowTime],
  )

  return (
    <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
      <TabList aria-label="Chart type">
        {MODES.map((m) => (
          <Tab key={m.id} value={m.id}>
            {m.label}
          </Tab>
        ))}
      </TabList>
      {MODES.map((m) => (
        <TabPanel key={m.id} value={m.id}>
          <div className="r-sunken p-1">
            <HourlyChart rows={rowsByMode[m.id]} mode={m.id} unit={m.unit} colors={colors} nowTime={nowMarker} />
          </div>
          <ChartLegend colors={colors} mode={m.id} showPast={showPast} />
        </TabPanel>
      ))}
    </Tabs>
  )
}
