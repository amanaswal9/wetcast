import * as RadixTabs from '@radix-ui/react-tabs'
import { useState } from 'react'
import { Chart } from '../../components/chart/Chart'
import { Button, GroupBox, MessageBox, Skeleton } from '../../components/retro'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useResource } from '../../hooks/useResource'
import type { Theme } from '../../hooks/useTheme'
import { getPredictions, TARGET_LABELS, TARGET_UNITS, type Predictions, type Target } from '../../lib/api/weatherai'
import { CHART_COLORS, MODEL_COLORS } from '../../lib/chartTheme'
import { coordKey, hhmm, round, utcToLocal } from '../../lib/format'
import type { Place, WeekForecast } from '../../types/weather'

const TARGETS: Target[] = ['temperature', 'humidity', 'precipitation']

interface Row {
  time: string
  model: number
  band: [number, number]
  openMeteo: number | null
}

function buildRows(data: Predictions, model: string, target: Target, week: WeekForecast): Row[] {
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
  return prediction.points.map((p) => {
    const local = utcToLocal(p.time, week.utcOffsetSeconds)
    const openMeteo = target === 'humidity' ? null : valueAt(Date.parse(p.time))
    return {
      time: local,
      model: p[target],
      band: [p[`${target}_lower`], p[`${target}_upper`]],
      openMeteo,
    }
  })
}

function format(value: number, target: Target): string {
  return target === 'precipitation' ? `${value.toFixed(1)} mm` : `${round(value)}${TARGET_UNITS[target] === '°C' ? '°C' : '%'}`
}

function PredictionTooltip({ row, target, modelName }: { row: Row; target: Target; modelName: string }) {
  return (
    <div className="r-tooltip tabular-nums">
      <div>{hhmm(row.time)} local time</div>
      <div>
        {modelName}: <b>{format(row.model, target)}</b> (range {format(row.band[0], target)} to {format(row.band[1], target)})
      </div>
      {row.openMeteo !== null && <div>Open-Meteo forecast: {format(row.openMeteo, target)}</div>}
    </div>
  )
}

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
  const step = wide ? 3 : 6
  const xTicks = rows.flatMap((r, i) => (Number(r.time.slice(11, 13)) % step === 0 ? [{ at: i, label: hhmm(r.time) }] : []))
  const hasOpenMeteo = rows.some((r) => r.openMeteo !== null)

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
            format: (v) => (target === 'precipitation' ? v.toFixed(1) : `${round(v)}`),
          }}
          series={[
            { type: 'band', key: 'band', lower: (r) => r.band[0], upper: (r) => r.band[1], color: modelColor, opacity: 0.45 },
            ...(hasOpenMeteo ? [{ type: 'line' as const, key: 'openMeteo', value: (r: Row) => r.openMeteo, color: colors.forecast, dash: '6 4' }] : []),
            { type: 'line', key: 'model', value: (r) => r.model, color: modelColor, width: 2.5 },
          ]}
          tooltip={(row) => <PredictionTooltip row={row} target={target} modelName={modelName} />}
          label={`${modelName} ${TARGET_LABELS[target].toLowerCase()} prediction`}
        />
      </div>
      <ul className="m-0 mt-2 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[0.92em]">
        <li className="flex items-center gap-1.5">
          <svg width="22" height="10" aria-hidden="true">
            <line x1="0" y1="5" x2="22" y2="5" stroke={modelColor} strokeWidth="2.5" />
          </svg>
          WeatherAI {modelName} prediction
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
    </>
  )
}

interface ModelPredictionPanelProps {
  place: Place
  week: WeekForecast
  theme: Theme
  onSelectPlace: (place: Place) => void
}

export function ModelPredictionPanel({ place, week, theme, onSelectPlace }: ModelPredictionPanelProps) {
  const result = useResource(`pred:${coordKey(place)}`, ({ signal }) => getPredictions(place.latitude, place.longitude, signal), 15 * 60_000)
  const [model, setModel] = useState<string | null>(null)
  const [target, setTarget] = useState<Target>('temperature')

  let body
  if (!result.data) {
    body =
      result.status === 'error' ? (
        <MessageBox kind="warning" role="alert" title="Predictions aren't available right now" actions={<Button onClick={result.reload}>Try again</Button>}>
          <p className="m-0">{result.error?.message} The rest of the forecast above still works.</p>
        </MessageBox>
      ) : (
        <Skeleton height={260} />
      )
  } else if (result.data.kind === 'unsupported') {
    body = (
      <MessageBox kind="info" title={`WeatherAI's models don't cover ${place.name}`}>
        <p className="m-0">
          They were trained on ten North India cities and only make predictions there. Open one of them to compare its model
          predictions with the forecast:
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {result.data.supported.map((c) => (
            <Button
              key={c.id}
              onClick={() => onSelectPlace({ id: `weatherai-${c.id}`, name: c.name, country: 'India', latitude: c.latitude, longitude: c.longitude })}
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
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Measure">
          {TARGETS.map((t) => (
            <Button key={t} aria-pressed={target === t} onClick={() => setTarget(t)}>
              {TARGET_LABELS[t]}
            </Button>
          ))}
        </div>
        <RadixTabs.Root value={active} onValueChange={setModel}>
          <RadixTabs.List aria-label="Model" className="r-tablist">
            {data.models.map((m) => (
              <RadixTabs.Trigger key={m.model} value={m.model} className="r-tab">
                {m.display_name}
              </RadixTabs.Trigger>
            ))}
          </RadixTabs.List>
          {data.models.map((m) => (
            <RadixTabs.Content key={m.model} value={m.model} className="r-tabpanel">
              <PredictionChart
                rows={buildRows(data, m.model, target, week)}
                target={target}
                theme={theme}
                model={m.model}
                modelName={m.display_name}
                halfHour={week.utcOffsetSeconds % 3600 !== 0}
              />
            </RadixTabs.Content>
          ))}
        </RadixTabs.Root>
        <p className="m-0 text-[0.92em] text-[var(--text-muted)]">
          Issued from data up to {hhmm(issuedLocal)} local time for {data.city.name}. {data.note} {data.source}{' '}
          <a href="#/models" className="text-[inherit]">
            See how each model was tested
          </a>
          .
        </p>
      </div>
    )
  }

  return <GroupBox title="WeatherAI model prediction, next 24 hours">{body}</GroupBox>
}
