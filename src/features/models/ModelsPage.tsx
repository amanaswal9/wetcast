import { useReducedMotion } from 'motion/react'
import { useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Button, GroupBox, Skeleton } from '../../components/retro'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useResource } from '../../hooks/useResource'
import type { Theme } from '../../hooks/useTheme'
import { getEvaluation, getModels, TARGET_LABELS, TARGET_UNITS, type Evaluation, type ModelMetrics, type Target } from '../../lib/api/weatherai'
import { CHART_COLORS, CHART_FONT, MODEL_COLORS } from '../../lib/chartTheme'
import { BackendNotice } from './BackendNotice'
import { DASHES, fmt, improvement } from './format'
import { Table } from './shared'
import { TrackRecordPanel } from './TrackRecord'

const TARGETS: Target[] = ['temperature', 'humidity', 'precipitation']

/** Plain-language names for LightGBM's input features. */
function featureLabel(name: string): string {
  const point: Record<string, string> = { c: 'city', n: 'north point', s: 'south point', e: 'east point', w: 'west point' }
  const what: Record<string, string> = {
    temp: 'temperature',
    rh: 'humidity',
    precip_log1p: 'rain',
    pressure: 'pressure',
    cloud: 'cloud',
    wind_u: 'east-west wind',
    wind_v: 'north-south wind',
  }
  const fixed: Record<string, string> = {
    prev_temperature: 'temperature 24 h earlier',
    prev_humidity: 'humidity 24 h earlier',
    prev_precipitation: 'rain 24 h earlier',
    hours_ahead: 'hours ahead',
    target_hour_sin: 'hour of day',
    target_hour_cos: 'hour of day',
    hour_sin: 'hour now',
    hour_cos: 'hour now',
    doy_sin: 'time of year',
    doy_cos: 'time of year',
    lat: 'latitude',
    lon: 'longitude',
    elevation: 'elevation',
  }
  if (fixed[name]) return fixed[name]
  const lag = name.match(/^(\w)_(.+)_lag(\d+)$/)
  if (lag) return `${point[lag[1]] ?? lag[1]} ${what[lag[2]] ?? lag[2]}, ${lag[3]} h ago`
  const m = name.match(/^(\w)_(.+)$/)
  return m && point[m[1]] ? `${point[m[1]]} ${what[m[2]] ?? m[2]} now` : name
}

function TargetPicker({ value, onChange }: { value: Target; onChange: (t: Target) => void }) {
  return (
    <div className="mb-2 flex flex-wrap gap-1.5" role="group" aria-label="Measure">
      {TARGETS.map((t) => (
        <Button key={t} aria-pressed={value === t} onClick={() => onChange(t)}>
          {TARGET_LABELS[t]}
        </Button>
      ))}
    </div>
  )
}

function MaeBars({ models, target, theme }: { models: ModelMetrics[]; target: Target; theme: Theme }) {
  const colors = CHART_COLORS[theme]
  const reduceMotion = useReducedMotion()
  const data = [
    ...models.map((m) => ({ name: m.display_name, key: m.model, mae: m.test[target].mae })),
    { name: 'Persistence', key: 'baseline', mae: models[0].persistence_baseline[target].mae },
  ]
  const tick = { fill: colors.text, fontSize: 11, fontFamily: CHART_FONT }
  return (
    <div className="r-sunken mt-3 p-1">
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ top: 12, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={colors.grid} vertical={false} />
          <XAxis dataKey="name" tick={tick} tickLine={false} axisLine={{ stroke: colors.axis }} />
          <YAxis width={48} tick={tick} tickLine={false} axisLine={{ stroke: colors.axis }} tickFormatter={(v: number) => v.toFixed(target === 'precipitation' ? 2 : 1)} />
          <Tooltip
            cursor={{ fill: colors.grid }}
            content={({ active, payload }) =>
              active && payload?.length ? (
                <div className="r-tooltip tabular-nums">
                  {String(payload[0].payload.name)}: MAE {fmt(Number(payload[0].value), 3)} {TARGET_UNITS[target]}
                </div>
              ) : null
            }
          />
          <Bar dataKey="mae" isAnimationActive={!reduceMotion} animationDuration={400}>
            {data.map((d) => (
              <Cell key={d.key} fill={MODEL_COLORS[theme][d.key] ?? colors.past} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <p className="m-0 px-1 pt-1 text-[0.92em] text-[var(--text-muted)]">Mean absolute error on the test period (lower is better), {TARGET_UNITS[target]}.</p>
    </div>
  )
}

function HorizonChart({ evaluations, models, target, theme }: { evaluations: Evaluation[]; models: ModelMetrics[]; target: Target; theme: Theme }) {
  const colors = CHART_COLORS[theme]
  const wide = useMediaQuery('(min-width: 640px)')
  const rows = Array.from({ length: evaluations[0]?.per_horizon_mae[target].length ?? 0 }, (_, h) => {
    const row: Record<string, number> = { lead: h + 1 }
    evaluations.forEach((e) => {
      row[e.model] = e.per_horizon_mae[target][h]
    })
    return row
  })
  const tick = { fill: colors.text, fontSize: 11, fontFamily: CHART_FONT }
  const names = Object.fromEntries(models.map((m) => [m.model, m.display_name]))
  return (
    <>
      <div className="r-sunken p-1">
        <ResponsiveContainer width="100%" height={wide ? 240 : 200}>
          <LineChart data={rows} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={colors.grid} vertical={false} />
            <XAxis dataKey="lead" tick={tick} tickLine={{ stroke: colors.axis }} axisLine={{ stroke: colors.axis }} ticks={[1, 6, 12, 18, 24]} tickFormatter={(v: number) => `${v} h`} />
            <YAxis width={48} tick={tick} tickLine={false} axisLine={{ stroke: colors.axis }} tickFormatter={(v: number) => v.toFixed(target === 'precipitation' ? 2 : 1)} domain={[0, 'auto']} />
            <Tooltip
              cursor={{ stroke: colors.axis, strokeDasharray: '2 2' }}
              content={({ active, payload, label }) =>
                active && payload?.length ? (
                  <div className="r-tooltip tabular-nums">
                    <div>{String(label)} h ahead</div>
                    {payload.map((p) => (
                      <div key={String(p.dataKey)}>
                        {names[String(p.dataKey)]}: MAE {fmt(Number(p.value), 3)} {TARGET_UNITS[target]}
                      </div>
                    ))}
                  </div>
                ) : null
              }
            />
            {evaluations.map((e, i) => (
              <Line key={e.model} dataKey={e.model} stroke={MODEL_COLORS[theme][e.model]} strokeWidth={2} strokeDasharray={DASHES[i % DASHES.length]} dot={false} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <ul className="m-0 mt-2 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[0.92em]">
        {evaluations.map((e, i) => (
          <li key={e.model} className="flex items-center gap-1.5">
            <svg width="26" height="10" aria-hidden="true">
              <line x1="0" y1="5" x2="26" y2="5" stroke={MODEL_COLORS[theme][e.model]} strokeWidth="2" strokeDasharray={DASHES[i % DASHES.length]} />
            </svg>
            {names[e.model]}
          </li>
        ))}
      </ul>
    </>
  )
}

/** One line per architecture, in plain words. */
const ARCHITECTURES: Record<string, string> = {
  lstm: 'two layers of long short-term memory cells reading the 48 hours in order.',
  gru: 'like the LSTM, with simpler gated recurrent units.',
  cnn_lstm: 'convolutions pick out short patterns across the five points, then an LSTM follows how they change.',
  transformer:
    'a spatio-temporal Transformer. Each point’s hours are cut into 6-hour patches, and attention compares every patch of every point with every other, so it can link, for example, the west point’s pressure 18 hours ago to the city’s next day.',
  lightgbm: 'gradient-boosted decision trees, one row per hour ahead, built from the current readings and recent lags.',
  ensemble: 'the plain average of the members listed above in “Test-set results”, chosen on the validation year.',
}

function minutes(seconds: number): string {
  return seconds < 90 ? `${Math.round(seconds)} s` : `${(seconds / 60).toFixed(1)} min`
}

export function ModelsPage({ theme }: { theme: Theme }) {
  const models = useResource('models', ({ signal }) => getModels(signal))
  const names = models.data?.map((m) => m.model).join(',') ?? null
  const evaluations = useResource(names ? `eval:${names}` : null, ({ signal }) =>
    Promise.all((models.data ?? []).map((m) => getEvaluation(m.model, {}, signal))),
  )
  const [target, setTarget] = useState<Target>('temperature')

  if (!models.data) {
    return models.status === 'error' ? (
      <div className="r-group">
        <BackendNotice message={models.error?.message} onRetry={models.reload} />
      </div>
    ) : (
      <div className="flex flex-col gap-3" aria-busy="true">
        <GroupBox title="Test-set results">
          <Skeleton height={220} />
        </GroupBox>
      </div>
    )
  }

  const list = models.data
  if (list.length === 0) {
    return (
      <div className="r-group">
        <p className="m-0">No trained models are available on the server yet.</p>
      </div>
    )
  }
  const first = list[0]
  const unit = TARGET_UNITS[target]
  const digits = target === 'precipitation' ? 3 : 2

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <GroupBox title="Test-set results">
        <p className="m-0 mb-2 max-w-[75ch]">
          Every number below comes from the {first.data.splits.test[0].slice(0, 10)} to {first.data.splits.test[1].slice(0, 10)} test
          period, which the models never saw while training. Persistence is a naive baseline that predicts the same hour on the
          previous day; a useful model should beat it.
          {(() => {
            const ens = list.find((m) => m.kind === 'ensemble')
            if (!ens) return null
            const names = (ens.members ?? []).map((n) => list.find((m) => m.model === n)?.display_name ?? n).join(', ')
            return ` The Ensemble is the plain average of ${names}, with equal weights. Which models to include was decided on the validation year, not the test period.`
          })()}
        </p>
        <TargetPicker value={target} onChange={setTarget} />
        <Table
          caption={`${TARGET_LABELS[target]} errors on the test period`}
          head={['Model', `MAE (${unit})`, `RMSE (${unit})`, 'R²', 'MAE vs persistence']}
          rows={[
            ...list.map((m) => [
              m.display_name,
              fmt(m.test[target].mae, digits),
              fmt(m.test[target].rmse, digits),
              fmt(m.test[target].r2, 3),
              improvement(m.test[target].mae, m.persistence_baseline[target].mae),
            ]),
            ['Persistence baseline', fmt(first.persistence_baseline[target].mae, digits), fmt(first.persistence_baseline[target].rmse, digits), fmt(first.persistence_baseline[target].r2, 3), '–'],
          ]}
        />
        <MaeBars models={list} target={target} theme={theme} />
        {target === 'precipitation' && (
          <p className="m-0 mt-2 max-w-[75ch] text-[0.92em]">
            Hourly rainfall is hard to predict: most hours are dry and rain is patchy, so R² for rain is expected to be low.
          </p>
        )}
      </GroupBox>

      <GroupBox title="Live track record">
        <TrackRecordPanel models={list} target={target} theme={theme} />
      </GroupBox>

      <GroupBox title="Error by hours ahead (test period)">
        {evaluations.data ? (
          <HorizonChart evaluations={evaluations.data} models={list} target={target} theme={theme} />
        ) : evaluations.status === 'error' ? (
          <BackendNotice message={evaluations.error?.message} onRetry={evaluations.reload} />
        ) : (
          <Skeleton height={240} />
        )}
        <p className="m-0 mt-1 text-[0.92em] text-[var(--text-muted)]">Mean absolute error for each hour of the 24-hour forecast, {TARGET_LABELS[target].toLowerCase()} ({unit}).</p>
      </GroupBox>

      <GroupBox title="Error ranges">
        <p className="m-0 mb-2 max-w-[75ch]">
          Each prediction comes with a range sized from errors on the {first.data.splits.val[0].slice(0, 4)} validation year ({first.interval.method}).
          The table shows how often the real value actually fell inside it during the test period. The target is {Math.round(first.interval.level * 100)}%.
        </p>
        <Table
          caption="Share of test values inside the error range"
          head={['Model', ...TARGETS.map((t) => TARGET_LABELS[t])]}
          rows={list.map((m) => [m.display_name, ...TARGETS.map((t) => `${(m.interval.test_coverage[t] * 100).toFixed(1)}%`)])}
        />
      </GroupBox>

      <GroupBox title="Check against weather stations">
        {first.station_check?.overall?.temperature ? (
          <>
            <p className="m-0 mb-2 max-w-[75ch]">
              The models learn from Open-Meteo data. Here their test-period predictions are compared with what nearby weather stations
              actually measured ({first.station_check.source}). The last row scores Open-Meteo's own data against the same stations.
            </p>
            <Table
              caption="Mean absolute error against station measurements"
              head={['Source', 'Temp, 6 h ahead', 'Temp, 24 h ahead', 'Humidity, 6 h ahead', 'Humidity, 24 h ahead']}
              rows={[
                ...list.map((m) => {
                  const o = m.station_check?.overall
                  return [
                    m.display_name,
                    o?.temperature?.lead6 ? `${fmt(o.temperature.lead6.mae)} °C` : 'n/a',
                    o?.temperature?.lead24 ? `${fmt(o.temperature.lead24.mae)} °C` : 'n/a',
                    o?.humidity?.lead6 ? `${fmt(o.humidity.lead6.mae, 1)}%` : 'n/a',
                    o?.humidity?.lead24 ? `${fmt(o.humidity.lead24.mae, 1)}%` : 'n/a',
                  ]
                }),
                [
                  'Open-Meteo data itself',
                  first.station_check.overall.temperature.open_meteo ? `${fmt(first.station_check.overall.temperature.open_meteo.mae)} °C` : 'n/a',
                  '–',
                  first.station_check.overall.humidity?.open_meteo ? `${fmt(first.station_check.overall.humidity.open_meteo.mae, 1)}%` : 'n/a',
                  '–',
                ],
              ]}
            />
          </>
        ) : (
          <p className="m-0">Station comparison isn't available for this training run{first.station_check?.reason ? `: ${first.station_check.reason}` : '.'}</p>
        )}
      </GroupBox>

      {(() => {
        const gbm = list.find((m) => m.kind === 'gbm' && m.feature_importance)
        if (!gbm?.feature_importance) return null
        // Time features are stored as sine/cosine pairs; combine each pair under one name.
        const combined = new Map<string, number>()
        for (const f of gbm.feature_importance[target]) {
          const label = featureLabel(f.feature)
          combined.set(label, (combined.get(label) ?? 0) + f.share)
        }
        const top = [...combined.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([feature, share]) => ({ feature, share }))
        return (
          <GroupBox title={`What ${gbm.display_name} relies on`}>
            <p className="m-0 mb-2 max-w-[75ch]">
              Unlike the neural networks, LightGBM can show which inputs mattered most. For {TARGET_LABELS[target].toLowerCase()}, its top
              five, by share of the model&apos;s total improvement:
            </p>
            <Table
              caption={`Most important inputs for ${TARGET_LABELS[target].toLowerCase()}`}
              head={['Input', 'Share']}
              rows={top.map((f) => [f.feature, `${(f.share * 100).toFixed(0)}%`])}
            />
          </GroupBox>
        )
      })()}

      <GroupBox title="Speed and size">
        <Table
          caption="Model size, training and inference time"
          head={['Model', 'Parameters', 'Epochs (best)', 'Training time', 'One forecast', 'Per forecast, batch of 256']}
          rows={list.map((m) => [
            m.display_name,
            m.parameters.toLocaleString(),
            m.kind === 'ensemble'
              ? 'Averages the others'
              : m.kind === 'gbm' && m.trees
                ? `${TARGETS.map((t) => m.trees![t]).join(' / ')} trees`
                : `${m.training.epochs_run} (${m.training.best_epoch})`,
            m.kind === 'ensemble' ? 'None of its own' : minutes(m.training.seconds),
            `${fmt(m.inference.single_ms_median, 1)} ms`,
            `${fmt(m.inference.batch256_ms_per_forecast, 3)} ms`,
          ])}
        />
        <p className="m-0 mt-2 text-[0.92em] text-[var(--text-muted)]">
          Measured on {first.inference.device} ({first.inference.cpu}). TensorFlow {first.framework.tensorflow}, Keras {first.framework.keras}.
        </p>
      </GroupBox>

      <GroupBox title="Data and method">
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
          <dt>Region</dt>
          <dd className="m-0">
            {first.data.region}: {first.data.cities.map((c) => c.name).join(', ')}
          </dd>
          <dt>Data</dt>
          <dd className="m-0">{first.data.source}</dd>
          <dt>Inputs</dt>
          <dd className="m-0">
            Last {first.data.lookback_hours} hours of {first.data.n_features} features: temperature, humidity, rain, pressure, wind and cloud at
            the city and four points about 55 km away, plus time of day, season and location.
          </dd>
          <dt>Outputs</dt>
          <dd className="m-0">Next {first.data.horizon_hours} hours of temperature, humidity and rain at the city.</dd>
          <dt>Models</dt>
          <dd className="m-0">
            <ul className="m-0 flex flex-col gap-0.5 pl-5">
              {list.map((m) => (
                <li key={m.model}>
                  <b>{m.display_name}:</b> {ARCHITECTURES[m.model] ?? 'a trained forecasting model.'}
                </li>
              ))}
            </ul>
          </dd>
          {first.config && (
            <>
              <dt>Method</dt>
              <dd className="m-0">
                {first.config.target_mode === 'residual24'
                  ? 'For temperature and humidity the models predict the change from the same hour the day before, then add it back; rain is predicted directly.'
                  : 'The models predict each value directly.'}{' '}
                {first.config.loss === 'huber' ? 'Huber loss' : 'Mean squared error loss'}, one training sample every {first.config.train_stride_hours} hours.
                Settings were chosen on the validation year only.
              </dd>
            </>
          )}
          <dt>Training</dt>
          <dd className="m-0">
            {first.data.splits.train[0].slice(0, 10)} to {first.data.splits.train[1].slice(0, 10)}
          </dd>
          <dt>Validation</dt>
          <dd className="m-0">
            {first.data.splits.val[0].slice(0, 10)} to {first.data.splits.val[1].slice(0, 10)} (early stopping and error ranges)
          </dd>
          <dt>Test</dt>
          <dd className="m-0">
            {first.data.splits.test[0].slice(0, 10)} to {first.data.splits.test[1].slice(0, 10)} ({first.windows.test.toLocaleString()} forecasts)
          </dd>
          <dt>Trained</dt>
          <dd className="m-0">{new Date(first.trained_at).toLocaleString()}</dd>
        </dl>
      </GroupBox>
    </div>
  )
}
