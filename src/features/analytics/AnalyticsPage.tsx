import { useId, useState } from 'react'
import { Chart } from '../../components/chart/Chart'
import { Button, ChartSkeleton, GroupBox, MessageBox, TextSkeleton } from '../../components/retro'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useResource } from '../../hooks/useResource'
import type { Theme } from '../../hooks/useTheme'
import { getDailyHistory } from '../../lib/api/openMeteo'
import { getEvaluation, getModels, TARGET_LABELS, TARGET_UNITS, type Target } from '../../lib/api/weatherai'
import { CHART_COLORS, MODEL_COLORS } from '../../lib/chartTheme'
import { coordKey, placeShortLabel, round, shortDate } from '../../lib/format'
import { useFormat } from '../../lib/units'
import type { Place } from '../../types/weather'
import { BackendNotice } from '../models/BackendNotice'

const TARGETS: Target[] = ['temperature', 'humidity', 'precipitation']
const RANGES = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
]

// A labelled row of toggle buttons, one per option.
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

// A test-period value with its unit: rain to a tenth of a millimetre, the rest rounded.
function fmtValue(v: number, target: Target) {
  return target === 'precipitation' ? `${v.toFixed(1)} mm` : `${round(v)}${TARGET_UNITS[target]}`
}

// "2026-10-17T05:00Z" -> India local (UTC+5:30) date label. The trained region is all in IST.
function istLabel(utc: string): string {
  const d = new Date(Date.parse(utc.replace('Z', ':00Z')) + 5.5 * 3_600_000)
  return d.toISOString().slice(0, 10)
}

// The test period, hour by hour: one model's forecasts against what happened, for one city and one measure.
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

  if (!models.data) {
    return models.status === 'error' ? <BackendNotice message={models.error?.message} onRetry={models.reload} /> : <ChartSkeleton height={300} />
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
  const dayTicks = rows.flatMap((r, i) => (i % (wide ? 48 : 96) === 0 ? [{ at: i, label: shortDate(istLabel(r.time)) }] : []))
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
          {cities.some((c) => c.role === 'holdout') ? (
            <>
              <optgroup label="Trained on">
                {cities
                  .filter((c) => c.role !== 'holdout')
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </optgroup>
              <optgroup label="Held out (never trained on)">
                {cities
                  .filter((c) => c.role === 'holdout')
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </optgroup>
            </>
          ) : (
            cities.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))
          )}
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
        <ChartSkeleton height={260} />
      ) : (
        <>
          <div className="r-sunken p-1">
            <Chart
              rows={rows}
              colors={colors}
              height={wide ? 260 : 220}
              top={12}
              xTicks={dayTicks}
              y={{ domain: target === 'humidity' ? [0, 100] : ['auto', 'auto'], format: (v) => (target === 'precipitation' ? v.toFixed(1) : `${round(v)}`) }}
              series={[
                { type: 'line', key: 'actual', value: (r) => r.actual, color: colors.past, width: 1.5, curve: 'linear' },
                { type: 'line', key: 'predicted', value: (r) => r.predicted, color: modelColor, width: 1.5, dash: '5 2', curve: 'linear' },
              ]}
              tooltip={(row) => {
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
              label={`Actual and predicted ${TARGET_LABELS[target].toLowerCase()} in ${cityName}`}
            />
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
            <Chart
              rows={perCity}
              colors={colors}
              height={wide ? 220 : 250}
              top={8}
              xTicks={perCity.map((c, i) => ({ at: i, label: c.name }))}
              xTickAngle={wide ? 0 : -40}
              y={{ domain: [0, 'auto'], format: (v) => v.toFixed(target === 'precipitation' ? 2 : 1) }}
              series={[{ type: 'bars', key: 'mae', value: (c) => c.mae, color: (c) => (c.id === city ? modelColor : colors.barPast) }]}
              tooltip={(c) => (
                <div className="r-tooltip tabular-nums">
                  {c.name}: MAE {c.mae.toFixed(3)} {TARGET_UNITS[target]}
                </div>
              )}
              label={`${displayName} error by city`}
            />
          </div>
          <p className="m-0 text-[0.92em] text-[var(--text-muted)]">Mean absolute error over the whole test period and all 24 hours ahead ({TARGET_UNITS[target]}).</p>
        </>
      )}
    </div>
  )
}

// Daily highs, lows and rain for the place over the last 30, 90 or 365 days, from the ERA5 archive.
function HistoricalTrends({ place, theme }: { place: Place; theme: Theme }) {
  const [days, setDays] = useState(90)
  const history = useResource(`hist:${coordKey(place)}:${days}`, ({ signal }) => getDailyHistory(place, days, { signal }))
  const colors = CHART_COLORS[theme]
  const wide = useMediaQuery('(min-width: 640px)')
  const fmt = useFormat()

  // Weather history follows the viewer's units (the model scores above stay metric, as measured).
  const rows = (history.data ?? []).map((d) => ({
    date: d.date,
    range: d.tempMin !== null && d.tempMax !== null ? [fmt.temp(d.tempMin), fmt.temp(d.tempMax)] : null,
    mean: d.tempMean === null ? null : fmt.temp(d.tempMean),
    rain: d.precipitationSum,
  }))
  const step = Math.max(1, Math.round(rows.length / (wide ? 8 : 4)))
  const ticks = rows.flatMap((r, i) => (i % step === 0 ? [{ at: i, label: shortDate(r.date) }] : []))
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
        <>
          <TextSkeleton lines={1} />
          <ChartSkeleton height={wide ? 240 : 200} />
        </>
      ) : (
        <>
          <p className="m-0 tabular-nums">
            {placeShortLabel(place)}, {shortDate(rows[0]?.date ?? '')} to {shortDate(rows[rows.length - 1]?.date ?? '')}: average{' '}
            {means.length ? `${(means.reduce((a, b) => a + b, 0) / means.length).toFixed(1)}${fmt.tempUnit}` : 'n/a'}, total rain {totalRain.toFixed(0)} mm.
          </p>
          <div className="r-sunken p-1">
            <Chart
              rows={rows}
              colors={colors}
              height={wide ? 240 : 200}
              top={12}
              xTicks={ticks}
              y={{ format: (v) => `${round(v)}°` }}
              series={[
                { type: 'band', key: 'range', lower: (r) => r.range?.[0], upper: (r) => r.range?.[1], color: colors.forecast, opacity: 0.4 },
                { type: 'line', key: 'mean', value: (r) => r.mean, color: colors.past, width: 1.5, curve: 'linear' },
              ]}
              tooltip={(r) => (
                <div className="r-tooltip tabular-nums">
                  <div>{shortDate(r.date)}</div>
                  <div>Mean {r.mean === null ? 'n/a' : `${r.mean.toFixed(1)}${fmt.tempUnit}`}</div>
                  {r.range && (
                    <div>
                      Low {round(r.range[0])}°, high {round(r.range[1])}°
                    </div>
                  )}
                  <div>Rain {r.rain === null ? 'n/a' : `${r.rain.toFixed(1)} mm`}</div>
                </div>
              )}
              label={`Daily temperature in ${placeShortLabel(place)}`}
            />
          </div>
          <div className="r-sunken p-1">
            <Chart
              rows={rows}
              colors={colors}
              height={140}
              top={8}
              xTicks={ticks}
              y={{ domain: [0, 'auto'], format: (v) => `${round(v)}` }}
              series={[{ type: 'bars', key: 'rain', value: (r) => r.rain, color: colors.barForecast }]}
              tooltip={(r) => (
                <div className="r-tooltip tabular-nums">
                  {shortDate(r.date)}: {(r.rain ?? 0).toFixed(1)} mm
                </div>
              )}
              label={`Daily rain in ${placeShortLabel(place)}`}
            />
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

// Analytics page: predictions against what was measured, and past trends for the place.
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
