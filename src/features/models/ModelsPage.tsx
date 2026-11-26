import { useState } from 'react'
import { Chart } from '../../components/chart/Chart'
import { Button, ChartSkeleton, GroupBox, TableSkeleton } from '../../components/retro'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useResource } from '../../hooks/useResource'
import type { Theme } from '../../hooks/useTheme'
import { getEvaluation, getModels, TARGET_LABELS, TARGET_UNITS, type Evaluation, type ModelMetrics, type Target } from '../../lib/api/weatherai'
import { CHART_COLORS, MODEL_COLORS } from '../../lib/chartTheme'
import { BackendNotice } from './BackendNotice'
import { DASHES, fmt, improvement } from './format'
import { Table } from './shared'
import { TrackRecordPanel } from './TrackRecord'

const TARGETS: Target[] = ['temperature', 'humidity', 'precipitation']

// Plain-language names for LightGBM's input features.
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

// Buttons to switch the charts between temperature, humidity and rain.
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

// Each model's test-period error as a bar, with the persistence baseline to beat.
function MaeBars({ models, target, theme }: { models: ModelMetrics[]; target: Target; theme: Theme }) {
  const colors = CHART_COLORS[theme]
  const wide = useMediaQuery('(min-width: 640px)')
  const data = [
    ...models.map((m) => ({ name: m.display_name, key: m.model, mae: m.test[target].mae })),
    { name: 'Persistence', key: 'baseline', mae: models[0].persistence_baseline[target].mae },
  ]
  return (
    <div className="r-sunken mt-3 p-1">
      <Chart
        rows={data}
        colors={colors}
        height={wide ? 200 : 250}
        top={12}
        yWidth={48}
        xTicks={data.map((d, i) => ({ at: i, label: d.name }))}
        xTickAngle={wide ? 0 : -45}
        y={{ domain: [0, 'auto'], format: (v) => v.toFixed(target === 'precipitation' ? 2 : 1) }}
        series={[{ type: 'bars', key: 'mae', value: (d) => d.mae, color: (d) => MODEL_COLORS[theme][d.key] ?? colors.past }]}
        tooltip={(d) => (
          <div className="r-tooltip tabular-nums">
            {d.name}: MAE {fmt(d.mae, 3)} {TARGET_UNITS[target]}
          </div>
        )}
        label={`Test-period error by model, ${TARGET_LABELS[target].toLowerCase()}`}
      />
      <p className="m-0 px-1 pt-1 text-[0.92em] text-[var(--text-muted)]">Mean absolute error on the test period (lower is better), {TARGET_UNITS[target]}.</p>
    </div>
  )
}

// How each model's error grows from 1 to 24 hours ahead.
function HorizonChart({ evaluations, models, target, theme }: { evaluations: Evaluation[]; models: ModelMetrics[]; target: Target; theme: Theme }) {
  const colors = CHART_COLORS[theme]
  const wide = useMediaQuery('(min-width: 640px)')
  const rows = Array.from({ length: evaluations[0]?.per_horizon_mae[target].length ?? 0 }, (_, h) => ({ lead: h + 1 }))
  const names = Object.fromEntries(models.map((m) => [m.model, m.display_name]))
  return (
    <>
      <div className="r-sunken p-1">
        <Chart
          rows={rows}
          colors={colors}
          height={wide ? 240 : 200}
          top={12}
          yWidth={48}
          xTicks={[1, 6, 12, 18, 24].filter((l) => l <= rows.length).map((l) => ({ at: l - 1, label: `${l} h` }))}
          y={{ domain: [0, 'auto'], format: (v) => v.toFixed(target === 'precipitation' ? 2 : 1) }}
          series={evaluations.map((e, i) => ({
            type: 'line' as const,
            key: e.model,
            value: (r: { lead: number }) => e.per_horizon_mae[target][r.lead - 1],
            color: MODEL_COLORS[theme][e.model] ?? colors.model,
            dash: DASHES[i % DASHES.length] || undefined,
            curve: 'linear' as const,
          }))}
          tooltip={(r) => (
            <div className="r-tooltip tabular-nums">
              <div>{r.lead} h ahead</div>
              {evaluations.map((e) => (
                <div key={e.model}>
                  {names[e.model]}: MAE {fmt(e.per_horizon_mae[target][r.lead - 1], 3)} {TARGET_UNITS[target]}
                </div>
              ))}
            </div>
          )}
          label={`Test-period error by hours ahead, ${TARGET_LABELS[target].toLowerCase()}`}
        />
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

// One line per architecture, in plain words.
const ARCHITECTURES: Record<string, string> = {
  lstm: 'two layers of long short-term memory cells reading the 48 hours in order.',
  gru: 'like the LSTM, with simpler gated recurrent units.',
  cnn_lstm: 'convolutions pick out short patterns across the five points, then an LSTM follows how they change.',
  transformer:
    'a spatio-temporal Transformer. Each point’s hours are cut into 6-hour patches, and attention compares every patch of every point with every other, so it can link, for example, the west point’s pressure 18 hours ago to the city’s next day.',
  lightgbm: 'gradient-boosted decision trees, one row per hour ahead, built from the current readings and recent lags.',
  ridge:
    'a linear baseline from scikit-learn: Ridge regression on exactly the table LightGBM uses. It shows how much the non-linear models add over a straight line through the same inputs, and it is not part of the ensemble.',
  ensemble: 'the plain average of the members listed above in “Test-set results”, chosen on the validation year.',
}

// A training time in seconds, or minutes once it runs past a minute and a half.
function minutes(seconds: number): string {
  return seconds < 90 ? `${Math.round(seconds)} s` : `${(seconds / 60).toFixed(1)} min`
}

// Models page: test scores, the live track record, error ranges and how the models were built.
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
          <TableSkeleton rows={7} columns={4} />
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
  const ensemble = list.find((m) => m.rain_chance)
  const rainChance = ensemble?.rain_chance
  const amount = ensemble?.rain_amount
  const ensembleTest = ensemble?.test.precipitation
  const ensembleName = ensemble?.display_name ?? 'Ensemble'
  const training = first.data.cities.filter((c) => c.role !== 'holdout')
  const heldOut = first.data.cities.filter((c) => c.role === 'holdout')

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
        {first.test_unseen && first.persistence_baseline_unseen && (
          <>
            <p className="m-0 mt-3 mb-2 max-w-[75ch]">
              The table above is for the cities the models trained on (on days they never saw). To test them at places they had
              never seen at all, {heldOut.length} cities were kept out of training entirely: {heldOut.map((c) => c.name).join(', ')}.
              Each is at least 150 km from every training city. Anywhere else in India, expect accuracy like this.
            </p>
            <Table
              caption={`${TARGET_LABELS[target]} errors at the ${heldOut.length} held-out cities`}
              head={['Model', `MAE (${unit})`, `RMSE (${unit})`, 'R²', 'MAE vs persistence']}
              rows={[
                ...list.flatMap((m) =>
                  m.test_unseen
                    ? [
                        [
                          m.display_name,
                          fmt(m.test_unseen[target].mae, digits),
                          fmt(m.test_unseen[target].rmse, digits),
                          fmt(m.test_unseen[target].r2, 3),
                          improvement(m.test_unseen[target].mae, first.persistence_baseline_unseen![target].mae),
                        ],
                      ]
                    : [],
                ),
                [
                  'Persistence baseline',
                  fmt(first.persistence_baseline_unseen[target].mae, digits),
                  fmt(first.persistence_baseline_unseen[target].rmse, digits),
                  fmt(first.persistence_baseline_unseen[target].r2, 3),
                  '–',
                ],
              ]}
            />
          </>
        )}
        {target === 'precipitation' && (
          <p className="m-0 mt-2 max-w-[75ch] text-[0.92em]">
            Hourly rainfall is hard to predict: most hours are dry and rain is patchy, so R² for rain is expected to be low.
          </p>
        )}
        {target === 'precipitation' && rainChance && (
          <>
            <p className="m-0 mt-2 max-w-[75ch]">
              The individual models&apos; rain amounts run low: they learn the logarithm of rainfall with an average-error loss, which pulls them
              towards &ldquo;almost dry&rdquo;, and by that error an always-dry forecast would score almost as well.
              {amount && first.test.precipitation && (
                <>
                  {' '}The {ensembleName}&apos;s amounts are corrected to the expected amount by a small LightGBM model fitted on the validation year.
                  On the test period that raised its R² from {amount.test_before.r2.toFixed(3)} to {ensembleTest?.r2.toFixed(3)} and lowered its RMSE
                  from {amount.test_before.rmse.toFixed(3)} to {ensembleTest?.rmse.toFixed(3)} mm, while its MAE rose from{' '}
                  {amount.test_before.mae.toFixed(3)} to {ensembleTest?.mae.toFixed(3)} mm: expected amounts put a little rain on many hours that stay
                  dry, which MAE punishes, in exchange for amounts that are right on average and smaller big misses.
                </>
              )}
            </p>
            <p className="m-0 mt-2 max-w-[75ch]">
              What the models know best is when rain is likely. So the {ensembleName} also gives a chance of at least {rainChance.wet_mm} mm in each
              hour, fitted on the validation year. Lower Brier scores are better; the comparison always forecasts the validation year&apos;s rain
              frequency ({Math.round(rainChance.validation_rain_share * 100)}%).
              {rainChance.model?.outlook && rainChance.scores.test.isotonic_brier !== undefined && (
                <>
                  {' '}Besides the models&apos; own rain, it takes Open-Meteo&apos;s forecast for the same hour, made about a day earlier, as a hint:
                  that lowered the test Brier score from {rainChance.scores.test.isotonic_brier.toFixed(3)} (from the models alone) to{' '}
                  {rainChance.scores.test.brier.toFixed(3)}.
                  {rainChance.scores.test.without_forecast_brier !== undefined &&
                    ` When that forecast can't be fetched it still scores ${rainChance.scores.test.without_forecast_brier.toFixed(3)}.`}{' '}
                  The same hint didn't improve the rain amounts enough to keep it there.
                </>
              )}
            </p>
            <Table
              caption="Chance of rain on the test period (Brier score)"
              head={['Cities', 'Chance of rain', 'Always the usual frequency', 'Hours with rain']}
              rows={[
                ['Trained on', rainChance.scores.test.brier.toFixed(3), rainChance.scores.test.climatology_brier.toFixed(3), `${Math.round(rainChance.scores.test.rain_share * 100)}%`],
                ...(rainChance.scores.test_unseen
                  ? [['Held out', rainChance.scores.test_unseen.brier.toFixed(3), rainChance.scores.test_unseen.climatology_brier.toFixed(3), `${Math.round(rainChance.scores.test_unseen.rain_share * 100)}%`]]
                  : []),
              ]}
            />
            <p className="m-0 mt-2 max-w-[75ch] text-[0.92em] text-[var(--text-muted)]">
              When it said: {rainChance.scores.reliability_test.map((r) => `about ${Math.round(r.said * 100)}%, it rained ${Math.round(r.rained * 100)}% of the time`).join('; ')}.
            </p>
          </>
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
          <ChartSkeleton height={240} />
        )}
        <p className="m-0 mt-1 text-[0.92em] text-[var(--text-muted)]">Mean absolute error for each hour of the 24-hour forecast, {TARGET_LABELS[target].toLowerCase()} ({unit}).</p>
      </GroupBox>

      <GroupBox title="Error ranges">
        <p className="m-0 mb-2 max-w-[75ch]">
          Each prediction comes with a range sized from errors on the {first.data.splits.val[0].slice(0, 4)} validation year ({first.interval.method}).
          {first.interval.halfwidth_by_month &&
            ' Errors change with the season (spring is the hardest), so each calendar month gets its own ranges: wider in spring, narrower in autumn and winter.'}{' '}
          The table shows how often the real value actually fell inside it during the test period. The target is {Math.round(first.interval.level * 100)}%.
        </p>
        <Table
          caption={first.interval.test_coverage_unseen ? 'Share of test values inside the error range: trained cities, then held-out cities' : 'Share of test values inside the error range'}
          head={first.interval.test_coverage_unseen
            ? ['Model', ...TARGETS.map((t) => `${TARGET_LABELS[t]}, trained`), ...TARGETS.map((t) => `${TARGET_LABELS[t]}, held out`)]
            : ['Model', ...TARGETS.map((t) => TARGET_LABELS[t])]}
          rows={list.map((m) => [
            m.display_name,
            ...TARGETS.map((t) => `${(m.interval.test_coverage[t] * 100).toFixed(1)}%`),
            ...(first.interval.test_coverage_unseen
              ? TARGETS.map((t) => (m.interval.test_coverage_unseen ? `${(m.interval.test_coverage_unseen[t] * 100).toFixed(1)}%` : '–'))
              : []),
          ])}
        />
        {first.interval.test_coverage_unseen && (
          <p className="m-0 mt-2 max-w-[75ch] text-[0.92em] text-[var(--text-muted)]">
            The test period (January to November 2026) had a harder spring than 2025, so temperature and humidity ranges at the trained cities still fall a little short of
            {' '}{Math.round(first.interval.level * 100)}%. At the held-out cities the rain ranges are on the wide side.
          </p>
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
                : m.kind === 'linear'
                  ? 'Solved directly'
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
            {first.data.region}. Trained on {training.length} cities: {training.map((c) => c.name).join(', ')}.
            {heldOut.length > 0 && ` Held out to test new places: ${heldOut.map((c) => c.name).join(', ')}.`}
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
