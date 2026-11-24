import { Tabs as TabsRoot, TabsContent, TabsList, TabsTrigger } from '@radix-ui/react-tabs'
import { useState } from 'react'
import { Chart } from '../../components/chart/Chart'
import { Button, ChartSkeleton, GroupBox, MessageBox } from '../../components/retro'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useResource } from '../../hooks/useResource'
import type { Theme } from '../../hooks/useTheme'
import { getPredictions, TARGET_LABELS, type PredictionCoverage, type Predictions, type Target } from '../../lib/api/weatherai'
import { CHART_COLORS, MODEL_COLORS } from '../../lib/chartTheme'
import { coordKey, round, utcToLocal } from '../../lib/format'
import { useFormat, type Format } from '../../lib/units'
import type { Place, WeekForecast } from '../../types/weather'

const TARGETS: Target[] = ['temperature', 'humidity', 'precipitation']

interface Row {
  time: string
  model: number
  band: [number, number]
  openMeteo: number | null
  // Chance of rain in the hour (0-1), from the model that has one (the ensemble), shown with every model.
  chance: number | null
}

// Rows in the viewer's units: temperatures (model, its range and Open-Meteo) are converted together.
function buildRows(data: Predictions, model: string, target: Target, week: WeekForecast, fmt: Format): Row[] {
  const prediction = data.models.find((m) => m.model === model)
  if (!prediction) return []
  // Align on absolute (UTC) time. In half-hour time zones such as India (UTC+5:30) the
  // model's UTC hours fall between Open-Meteo's local hours, so interpolate linearly.
  const pick = (h: WeekForecast['hourly'][number]) =>
    target === 'temperature' ? h.temperature : target === 'precipitation' ? h.precipitation : null
  const series = week.hourly
    .map((h) => ({ t: Date.parse(`${h.time}:00Z`) - week.utcOffsetSeconds * 1000, v: pick(h) }))
    .filter((s): s is { t: number; v: number } => s.v !== null)
  const valueAt = (t: number): number | null => {
    for (let i = 0; i < series.length; i++) {
      if (series[i].t === t) return series[i].v
      if (series[i].t > t) {
        if (i === 0) return null
        const a = series[i - 1]
        const b = series[i]
        if (b.t - a.t > 3_600_000) return null
        return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t)
      }
    }
    return null
  }
  const conv = target === 'temperature' ? fmt.temp : (v: number) => v
  const chances = data.models.find((m) => m.points.some((p) => p.rain_chance != null))?.points
  return prediction.points.map((p, i) => {
    const local = utcToLocal(p.time, week.utcOffsetSeconds)
    const openMeteo = target === 'humidity' ? null : valueAt(Date.parse(p.time))
    return {
      time: local,
      model: conv(p[target]),
      band: [conv(p[`${target}_lower`]), conv(p[`${target}_upper`])],
      openMeteo: openMeteo === null ? null : conv(openMeteo),
      chance: chances?.[i]?.rain_chance ?? null,
    }
  })
}

// Values are already in the viewer's units (see buildRows).
function format(value: number, target: Target, fmt: Format): string {
  return target === 'precipitation' ? `${value.toFixed(1)} mm` : `${round(value)}${target === 'temperature' ? fmt.tempUnit : '%'}`
}

// The hover box: the model's value for that hour, with its range.
function PredictionTooltip({ row, target, modelName }: { row: Row; target: Target; modelName: string }) {
  const fmt = useFormat()
  return (
    <div className="r-tooltip tabular-nums">
      <div>{fmt.time(row.time)} local time</div>
      <div>
        {modelName}: <b>{format(row.model, target, fmt)}</b> (range {format(row.band[0], target, fmt)} to {format(row.band[1], target, fmt)})
      </div>
      {target === 'precipitation' && row.chance !== null && <div>Chance of rain this hour (Ensemble): {Math.round(row.chance * 100)}%</div>}
      {row.openMeteo !== null && <div>Open-Meteo forecast: {format(row.openMeteo, target, fmt)}</div>}
    </div>
  )
}

// The next 24 hours from one of Wetcast's models, with its range drawn as a dithered band.
function PredictionChart({
  rows,
  target,
  theme,
  model,
  modelName,
  halfHour,
}: {
  rows: Row[]
  target: Target
  theme: Theme
  model: string
  modelName: string
  halfHour: boolean
}) {
  const colors = CHART_COLORS[theme]
  const modelColor = MODEL_COLORS[theme][model] ?? colors.model
  const wide = useMediaQuery('(min-width: 640px)')
  const fmt = useFormat()
  const step = wide ? 3 : 6
  const xTicks = rows.flatMap((r, i) => (Number(r.time.slice(11, 13)) % step === 0 ? [{ at: i, label: fmt.hourTick(r.time) }] : []))
  const hasOpenMeteo = rows.some((r) => r.openMeteo !== null)
  const likeliest = target === 'precipitation' ? rows.reduce<Row | null>((best, r) => (r.chance !== null && (best === null || r.chance > (best.chance ?? 0)) ? r : best), null) : null

  return (
    <>
      <div className="r-sunken p-1">
        <Chart
          rows={rows}
          colors={colors}
          height={wide ? 260 : 220}
          top={12}
          xTicks={xTicks}
          y={{
            domain: target === 'humidity' ? [0, 100] : target === 'precipitation' ? [0, 'auto'] : ['auto', 'auto'],
            // Rain amounts are often below 1 mm; one decimal would label every tick "0.0".
            format: (v) => (target === 'precipitation' ? v.toFixed(v !== 0 && v < 1 ? 2 : 1) : `${round(v)}`),
          }}
          series={[
            { type: 'band', key: 'band', lower: (r) => r.band[0], upper: (r) => r.band[1], color: modelColor, opacity: 0.45 },
            ...(hasOpenMeteo ? [{ type: 'line' as const, key: 'openMeteo', value: (r: Row) => r.openMeteo, color: colors.forecast, dash: '6 4' }] : []),
            { type: 'line', key: 'model', value: (r) => r.model, color: modelColor, width: 2.5 },
          ]}
          tooltip={(row) => <PredictionTooltip row={row} target={target} modelName={modelName} />}
          label={`${modelName} ${TARGET_LABELS[target].toLowerCase()} prediction`}
          summary={
            rows.length > 0
              ? `${modelName} predicts ${TARGET_LABELS[target].toLowerCase()} from ${format(Math.min(...rows.map((r) => r.model)), target, fmt)} to ${format(
                  Math.max(...rows.map((r) => r.model)),
                  target,
                  fmt,
                )} over the next ${rows.length} hours.`
              : undefined
          }
        />
      </div>
      <ul className="m-0 mt-2 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[0.92em]">
        <li className="flex items-center gap-1.5">
          <svg width="22" height="10" aria-hidden="true">
            <line x1="0" y1="5" x2="22" y2="5" stroke={modelColor} strokeWidth="2.5" />
          </svg>
          Wetcast {modelName} prediction
        </li>
        <li className="flex items-center gap-1.5">
          <svg width="22" height="10" aria-hidden="true">
            <defs>
              <pattern id={`legend-dither-${model}-${theme}`} width="4" height="4" patternUnits="userSpaceOnUse">
                <rect width="2" height="2" fill={modelColor} />
                <rect x="2" y="2" width="2" height="2" fill={modelColor} />
              </pattern>
            </defs>
            <rect width="22" height="10" fill={`url(#legend-dither-${model}-${theme})`} opacity="0.45" />
          </svg>
          Error range
        </li>
        {hasOpenMeteo ? (
          <li className="flex items-center gap-1.5">
            <svg width="22" height="10" aria-hidden="true">
              <line x1="0" y1="5" x2="22" y2="5" stroke={colors.forecast} strokeWidth="2" strokeDasharray="5 3" />
            </svg>
            Open-Meteo forecast{halfHour ? ', interpolated to the model’s hours' : ''}
          </li>
        ) : target === 'humidity' ? (
          <li className="text-[var(--text-muted)]">Open-Meteo's hourly humidity isn't on this page, so only the model is shown.</li>
        ) : (
          <li className="text-[var(--text-muted)]">Open-Meteo's forecast for these hours isn't loaded, so only the model is shown.</li>
        )}
      </ul>
      {likeliest && likeliest.chance !== null && (
        <p className="m-0 mt-2" data-rain-chance>
          <b>Chance of rain (Ensemble):</b>{' '}
          {Math.round(likeliest.chance * 100) < 1
            ? 'under 1% in every hour.'
            : `highest ${Math.round(likeliest.chance * 100)}% in the hour to ${fmt.time(likeliest.time)}.`}{' '}
          <span className="text-[var(--text-muted)]">
            That is the chance of at least 0.1 mm falling in that one hour.{' '}
            {model === 'ensemble'
              ? 'The line is the expected amount: an average over how the hour could turn out, so a small amount can still come with a fair chance of a shower.'
              : 'This model’s amounts run low; the Ensemble’s are corrected to the expected amount.'}
          </span>
        </p>
      )}
    </>
  )
}

// What kind of place this is for the models, and the average error measured for that kind of place.
function CoverageNote({ coverage, modelName }: { coverage: PredictionCoverage; modelName: string }) {
  const fmt = useFormat()
  const { mae, basis, temperature_range: range } = coverage.expected_error
  const t = (c: number) => `${fmt.tempDelta(c).toFixed(1)} ${fmt.tempUnit}`
  const parts = [
    mae.temperature !== null && `${t(mae.temperature)} for temperature`,
    mae.humidity !== null && `${mae.humidity.toFixed(1)}% for humidity`,
    mae.precipitation !== null && `${mae.precipitation.toFixed(2)} mm for rain`,
  ].filter(Boolean)
  return (
    <p className="m-0" data-coverage={coverage.kind}>
      <b>{coverage.label}.</b> {coverage.detail}{' '}
      {parts.length > 0 && (
        <>
          Average error to expect from the {modelName}: {parts.join(', ')}, {basis}
          {range && ` (temperature ${t(range[0])} to ${t(range[1])} across them)`}.
        </>
      )}
    </p>
  )
}

interface ModelPredictionPanelProps {
  place: Place
  week: WeekForecast
  theme: Theme
  onSelectPlace: (place: Place) => void
}

// Wetcast's own model predictions for the place, one tab per model.
export function ModelPredictionPanel({ place, week, theme, onSelectPlace }: ModelPredictionPanelProps) {
  const result = useResource(
    `pred:${coordKey(place)}:${place.countryCode ?? ''}`,
    ({ signal }) => getPredictions(place.latitude, place.longitude, signal, false, place.countryCode),
    15 * 60_000,
  )
  const [model, setModel] = useState<string | null>(null)
  const [target, setTarget] = useState<Target>('temperature')
  const fmt = useFormat()

  let body
  if (!result.data) {
    body =
      result.status === 'error' ? (
        <MessageBox kind="warning" role="alert" title="Predictions aren't available right now" actions={<Button onClick={result.reload}>Try again</Button>}>
          <p className="m-0">{result.error?.message} The rest of the forecast above still works.</p>
        </MessageBox>
      ) : (
        <ChartSkeleton height={260} />
      )
  } else if (result.data.kind === 'unsupported') {
    body = (
      <MessageBox kind="info" title={`Wetcast's models don't cover ${place.name}`}>
        <p className="m-0">
          {result.data.detail} Open one of the nearest to compare its model predictions with the forecast:
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {result.data.supported.slice(0, 6).map((c) => (
            <Button
              key={c.id}
              onClick={() =>
                onSelectPlace({ id: `weatherai-${c.id}`, name: c.name, country: 'India', countryCode: 'IN', latitude: c.latitude, longitude: c.longitude })
              }
            >
              {c.name}
            </Button>
          ))}
        </div>
      </MessageBox>
    )
  } else {
    const data = result.data.data
    const active = model && data.models.some((m) => m.model === model) ? model : data.models[0]?.model
    const issuedLocal = utcToLocal(data.issued_at, week.utcOffsetSeconds)
    body = (
      <div className="flex min-w-0 flex-col gap-2">
        {data.coverage && (
          <CoverageNote
            coverage={data.coverage}
            modelName={data.models.find((m) => m.model === data.coverage.model)?.display_name ?? data.coverage.model}
          />
        )}
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Measure">
          {TARGETS.map((t) => (
            <Button key={t} aria-pressed={target === t} onClick={() => setTarget(t)}>
              {TARGET_LABELS[t]}
            </Button>
          ))}
        </div>
        <TabsRoot value={active} onValueChange={setModel}>
          <TabsList aria-label="Model" className="r-tablist">
            {data.models.map((m) => (
              <TabsTrigger key={m.model} value={m.model} className="r-tab">
                {m.display_name}
              </TabsTrigger>
            ))}
          </TabsList>
          {data.models.map((m) => (
            <TabsContent key={m.model} value={m.model} className="r-tabpanel">
              <PredictionChart
                rows={buildRows(data, m.model, target, week, fmt)}
                target={target}
                theme={theme}
                model={m.model}
                modelName={m.display_name}
                halfHour={week.utcOffsetSeconds % 3600 !== 0}
              />
            </TabsContent>
          ))}
        </TabsRoot>
        <p className="m-0 text-[0.92em] text-[var(--text-muted)]">
          Issued from data up to {fmt.time(issuedLocal)} local time for {data.coverage?.kind === 'untrained' ? `${place.name} (computed at ${data.city.name})` : data.city.name}. {data.note} {data.source}{' '}
          <a href="#/models" className="text-[inherit]">
            See how each model was tested
          </a>
          .
        </p>
      </div>
    )
  }

  return <GroupBox title="Wetcast model prediction, next 24 hours">{body}</GroupBox>
}
