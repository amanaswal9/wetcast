import { useId, useState } from 'react'
import { Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Button, GroupBox, MessageBox, Skeleton } from '../../components/retro'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useResource } from '../../hooks/useResource'
import type { Theme } from '../../hooks/useTheme'
import { getDailyHistory } from '../../lib/api/openMeteo'
import { getEvaluation, getModels, TARGET_LABELS, TARGET_UNITS, type Target } from '../../lib/api/weatherai'
import { CHART_COLORS, CHART_FONT, MODEL_COLORS } from '../../lib/chartTheme'
import { coordKey, placeShortLabel, round, shortDate } from '../../lib/format'
import type { Place } from '../../types/weather'
import { BackendNotice } from '../models/BackendNotice'

const TARGETS: Target[] = ['temperature', 'humidity', 'precipitation']
const RANGES = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
]

function PickerRow<T extends string | number>({ label, options, value, onChange }: { label: string; options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      <span className="min-w-[64px]">{label}</span>
      {options.map((o) => (
        <Button key={String(o.value)} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </Button>
      ))}
    </div>
  )
}

function fmtValue(v: number, target: Target) {
  return target === 'precipitation' ? `${v.toFixed(1)} mm` : `${round(v)}${TARGET_UNITS[target]}`
}

/** "2026-10-17T05:00Z" -> India local (UTC+5:30) date label. The trained region is all in IST. */
function istLabel(utc: string): string {
  const d = new Date(Date.parse(utc.replace('Z', ':00Z')) + 5.5 * 3_600_000)
  return d.toISOString().slice(0, 10)
}

function ActualVsPredicted({ theme }: { theme: Theme }) {
  const selectId = useId()
  const models = useResource('models', ({ signal }) => getModels(signal))
  const [model, setModel] = useState<string>('lstm')
  const [city, setCity] = useState<string>('delhi')
  const [target, setTarget] = useState<Target>('temperature')
  const [lead, setLead] = useState<6 | 24>(24)
  const available = models.data?.map((m) => m.model) ?? []
  const activeModel = available.includes(model) ? model : available[0]
  const evaluation = useResource(activeModel ? `eval:${activeModel}:${city}` : null, ({ signal }) => getEvaluation(activeModel!, { samplesFor: city }, signal))
  const colors = CHART_COLORS[theme]
  const wide = useMediaQuery('(min-width: 640px)')
  const tick = { fill: colors.text, fontSize: 11, fontFamily: CHART_FONT }

  if (!models.data) {
    return models.status === 'error' ? <BackendNotice message={models.error?.message} onRetry={models.reload} /> : <Skeleton height={300} />
  }
  if (models.data.length === 0) {
    return <p className="m-0">No trained models are available on the server yet, so there are no predictions to compare.</p>
  }
  const meta = models.data[0]
  const cities = meta.data.cities
  const cityName = cities.find((c) => c.id === city)?.name ?? city
  const displayName = models.data.find((m) => m.model === activeModel)?.display_name ?? activeModel
  const sample = evaluation.data?.samples?.[city]
  const rows =
    sample?.time.map((t, i) => ({
      time: String(t),
      actual: sample[`${target}_actual`][i] as number | null,
      predicted: sample[`${target}_lead${lead}`][i] as number | null,
    })) ?? []
  const dayTicks = rows.filter((_, i) => i % (wide ? 48 : 96) === 0).map((r) => r.time)
  const modelColor = MODEL_COLORS[theme][activeModel ?? 'lstm']
  const perCity = evaluation.data
    ? cities.map((c) => ({ id: c.id, name: c.name, mae: evaluation.data!.per_city_mae[target][c.id] }))
    : []

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <label htmlFor={selectId} className="min-w-[64px]">
          City
        </label>
        <select id={selectId} className="r-input" value={city} onChange={(e) => setCity(e.target.value)}>
          {cities.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <PickerRow label="Model" options={models.data.map((m) => ({ value: m.model, label: m.display_name }))} value={activeModel ?? ''} onChange={setModel} />
      <PickerRow label="Measure" options={TARGETS.map((t) => ({ value: t, label: TARGET_LABELS[t] }))} value={target} onChange={setTarget} />
      <PickerRow
        label="Issued"
        options={[
          { value: 6 as const, label: '6 h ahead' },
          { value: 24 as const, label: '24 h ahead' },
        ]}
        value={lead}
        onChange={setLead}
      />

      {evaluation.status === 'error' && !evaluation.data ? (
        <BackendNotice message={evaluation.error?.message} onRetry={evaluation.reload} />
      ) : !sample ? (
        <Skeleton height={260} />
      ) : (
        <>
          <div className="r-sunken p-1">
            <ResponsiveContainer width="100%" height={wide ? 260 : 220}>
              <LineChart data={rows} margin={{ top: 12, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={colors.grid} vertical={false} />
                <XAxis dataKey="time" ticks={dayTicks} interval={0} tickFormatter={(t: string) => shortDate(istLabel(t))} tick={tick} tickLine={{ stroke: colors.axis }} axisLine={{ stroke: colors.axis }} />
                <YAxis width={44} tick={tick} tickLine={false} axisLine={{ stroke: colors.axis }} domain={target === 'humidity' ? [0, 100] : ['auto', 'auto']} tickFormatter={(v: number) => (target === 'precipitation' ? v.toFixed(1) : `${round(v)}`)} />
                <Tooltip
                  cursor={{ stroke: colors.axis, strokeDasharray: '2 2' }}
                  isAnimationActive={false}
                  content={({ active, payload }) => {
                    const row = active && payload?.length ? (payload[0].payload as (typeof rows)[number]) : null
                    if (!row) return null
                    const local = new Date(Date.parse(row.time.replace('Z', ':00Z')) + 5.5 * 3_600_000).toISOString()
                    return (
                      <div className="r-tooltip tabular-nums">
                        <div>
                          {shortDate(local.slice(0, 10))} {local.slice(11, 16)} IST
                        </div>
                        <div>Actual: {row.actual === null ? 'n/a' : fmtValue(row.actual, target)}</div>
                        <div>
                          {displayName}, {lead} h ahead: {row.predicted === null ? 'n/a' : fmtValue(row.predicted, target)}
                        </div>
                      </div>
                    )
                  }}
                />
                <Line dataKey="actual" stroke={colors.past} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls={false} />
                <Line dataKey="predicted" stroke={modelColor} strokeWidth={1.5} strokeDasharray="5 2" dot={false} isAnimationActive={false} connectNulls={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[0.92em]">
            <li className="flex items-center gap-1.5">
              <svg width="22" height="10" aria-hidden="true">
                <line x1="0" y1="5" x2="22" y2="5" stroke={colors.past} strokeWidth="2" />
              </svg>
              Actual (Open-Meteo hourly data, the training target)
            </li>
            <li className="flex items-center gap-1.5">
              <svg width="22" height="10" aria-hidden="true">
                <line x1="0" y1="5" x2="22" y2="5" stroke={modelColor} strokeWidth="2" strokeDasharray="5 2" />
              </svg>
              {displayName} prediction issued {lead} h earlier
            </li>
          </ul>
          <p className="m-0 text-[0.92em] text-[var(--text-muted)]">
            {cityName}: the last 14 days of the test period, which the model never saw in training.
          </p>

          <h3 className="m-0 mt-3 text-[inherit] font-bold">
            {displayName} error by city, {TARGET_LABELS[target].toLowerCase()}
          </h3>
          <div className="r-sunken p-1">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={perCity} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={colors.grid} vertical={false} />
                <XAxis dataKey="name" tick={tick} interval={0} angle={wide ? 0 : -40} textAnchor={wide ? 'middle' : 'end'} height={wide ? 24 : 50} tickLine={false} axisLine={{ stroke: colors.axis }} />
                <YAxis width={44} tick={tick} tickLine={false} axisLine={{ stroke: colors.axis }} tickFormatter={(v: number) => v.toFixed(target === 'precipitation' ? 2 : 1)} />
                <Tooltip
                  cursor={{ fill: colors.grid }}
                  isAnimationActive={false}
                  content={({ active, payload }) =>
                    active && payload?.length ? (
                      <div className="r-tooltip tabular-nums">
                        {String(payload[0].payload.name)}: MAE {Number(payload[0].value).toFixed(3)} {TARGET_UNITS[target]}
                      </div>
                    ) : null
                  }
                />
                <Bar dataKey="mae" isAnimationActive={false}>
                  {perCity.map((c) => (
                    <Cell key={c.id} fill={c.id === city ? modelColor : colors.barPast} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="m-0 text-[0.92em] text-[var(--text-muted)]">Mean absolute error over the whole test period and all 24 hours ahead ({TARGET_UNITS[target]}).</p>
        </>
      )}
    </div>
  )
}

function HistoricalTrends({ place, theme }: { place: Place; theme: Theme }) {
  const [days, setDays] = useState(90)
  const history = useResource(`hist:${coordKey(place)}:${days}`, ({ signal }) => getDailyHistory(place, days, { signal }))
  const colors = CHART_COLORS[theme]
  const wide = useMediaQuery('(min-width: 640px)')
  const tick = { fill: colors.text, fontSize: 11, fontFamily: CHART_FONT }
  const patternId = `hist-band-${theme}`

  const rows = (history.data ?? []).map((d) => ({
    date: d.date,
    range: d.tempMin !== null && d.tempMax !== null ? [d.tempMin, d.tempMax] : null,
    mean: d.tempMean,
    rain: d.precipitationSum,
  }))
  const step = Math.max(1, Math.round(rows.length / (wide ? 8 : 4)))
  const ticks = rows.filter((_, i) => i % step === 0).map((r) => r.date)
  const totalRain = rows.reduce((s, r) => s + (r.rain ?? 0), 0)
  const means = rows.map((r) => r.mean).filter((v): v is number => v !== null)

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <PickerRow label="Period" options={RANGES.map((r) => ({ value: r.days, label: r.label }))} value={days} onChange={setDays} />
      {history.status === 'error' && !history.data ? (
        <MessageBox kind="warning" role="alert" title="Couldn't load the history" actions={<Button onClick={history.reload}>Try again</Button>}>
          {history.error?.message}
        </MessageBox>
      ) : !history.data ? (
        <Skeleton height={300} />
      ) : (
        <>
          <p className="m-0 tabular-nums">
            {placeShortLabel(place)}, {shortDate(rows[0]?.date ?? '')} to {shortDate(rows[rows.length - 1]?.date ?? '')}: average{' '}
            {means.length ? `${(means.reduce((a, b) => a + b, 0) / means.length).toFixed(1)}°C` : 'n/a'}, total rain {totalRain.toFixed(0)} mm.
          </p>
          <div className="r-sunken p-1">
            <ResponsiveContainer width="100%" height={wide ? 240 : 200}>
              <ComposedChart data={rows} margin={{ top: 12, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <pattern id={patternId} width="4" height="4" patternUnits="userSpaceOnUse">
                    <rect width="2" height="2" fill={colors.forecast} />
                    <rect x="2" y="2" width="2" height="2" fill={colors.forecast} />
                  </pattern>
                </defs>
                <CartesianGrid stroke={colors.grid} vertical={false} />
                <XAxis dataKey="date" ticks={ticks} interval={0} tickFormatter={shortDate} tick={tick} tickLine={{ stroke: colors.axis }} axisLine={{ stroke: colors.axis }} />
                <YAxis width={44} tick={tick} tickLine={false} axisLine={{ stroke: colors.axis }} tickFormatter={(v: number) => `${round(v)}°`} domain={['auto', 'auto']} />
                <Tooltip
                  cursor={{ stroke: colors.axis, strokeDasharray: '2 2' }}
                  isAnimationActive={false}
                  content={({ active, payload }) => {
                    const r = active && payload?.length ? (payload[0].payload as (typeof rows)[number]) : null
                    if (!r) return null
                    return (
                      <div className="r-tooltip tabular-nums">
                        <div>{shortDate(r.date)}</div>
                        <div>Mean {r.mean === null ? 'n/a' : `${r.mean.toFixed(1)}°C`}</div>
                        {r.range && (
                          <div>
                            Low {round(r.range[0])}°, high {round(r.range[1])}°
                          </div>
                        )}
                        <div>Rain {r.rain === null ? 'n/a' : `${r.rain.toFixed(1)} mm`}</div>
                      </div>
                    )
                  }}
                />
                <Area dataKey="range" stroke="none" fill={`url(#${patternId})`} fillOpacity={0.4} isAnimationActive={false} />
                <Line dataKey="mean" stroke={colors.past} strokeWidth={1.5} dot={false} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="r-sunken p-1">
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={colors.grid} vertical={false} />
                <XAxis dataKey="date" ticks={ticks} interval={0} tickFormatter={shortDate} tick={tick} tickLine={{ stroke: colors.axis }} axisLine={{ stroke: colors.axis }} />
                <YAxis width={44} tick={tick} tickLine={false} axisLine={{ stroke: colors.axis }} tickFormatter={(v: number) => `${round(v)}`} />
                <Tooltip
                  cursor={{ fill: colors.grid }}
                  isAnimationActive={false}
                  content={({ active, payload }) =>
                    active && payload?.length ? (
                      <div className="r-tooltip tabular-nums">
                        {shortDate(String(payload[0].payload.date))}: {Number(payload[0].value ?? 0).toFixed(1)} mm
                      </div>
                    ) : null
                  }
                />
                <Bar dataKey="rain" fill={colors.barForecast} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="m-0 text-[0.92em] text-[var(--text-muted)]">
            Daily mean temperature (line), daily low to high (shaded) and daily rain in mm (bars). Source: Open-Meteo historical
            archive (ERA5 reanalysis), which runs about 5 days behind today.
          </p>
        </>
      )}
    </div>
  )
}

export function AnalyticsPage({ place, theme }: { place: Place; theme: Theme }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <GroupBox title="Actual vs predicted">
        <ActualVsPredicted theme={theme} />
      </GroupBox>
      <GroupBox title={`Historical trends for ${place.name}`}>
        <HistoricalTrends place={place} theme={theme} />
      </GroupBox>
    </div>
  )
}
