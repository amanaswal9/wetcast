import { useState } from 'react'
import { Chart } from '../../components/chart/Chart'
import { Button, TableSkeleton, TextSkeleton } from '../../components/retro'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { useResource } from '../../hooks/useResource'
import type { Theme } from '../../hooks/useTheme'
import { getTrackRecord, TARGET_LABELS, TARGET_UNITS, type ModelMetrics, type Target, type TrackRecord, type TrackStats } from '../../lib/api/weatherai'
import { CHART_COLORS, MODEL_COLORS } from '../../lib/chartTheme'
import { getUnits } from '../../lib/units'
import { BackendNotice } from './BackendNotice'
import { DASHES, fmt, improvement } from './format'
import { Table } from './shared'

const WINDOWS = [7, 30, 90] as const
const LEADS = ['1-6', '7-12', '13-18', '19-24']
const PERSISTENCE = 'persistence'

function dayLabel(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: getUnits().clock === '12' })
}

/** Daily rows for the chart: one MAE per model plus persistence on the same hours (weighted by hours scored). */
function dailyRows(record: TrackRecord, target: Target) {
  const byDate = new Map<string, { mae: Record<string, number>; n: number; persistence: number }>()
  for (const r of record.daily) {
    if (r.target !== target) continue
    const day = byDate.get(r.date) ?? { mae: {}, n: 0, persistence: 0 }
    day.mae[r.model] = r.mae
    day.n += r.n
    day.persistence += r.persistence_mae * r.n
    byDate.set(r.date, day)
  }
  return [...byDate.entries()].map(([date, day]) => ({ date, ...day.mae, [PERSISTENCE]: day.persistence / day.n }))
}

function DailyChart({ record, target, theme }: { record: TrackRecord; target: Target; theme: Theme }) {
  const colors = CHART_COLORS[theme]
  const wide = useMediaQuery('(min-width: 640px)')
  const rows = dailyRows(record, target)
  const names: Record<string, string> = { ...Object.fromEntries(record.models.map((m) => [m.model, m.display_name])), [PERSISTENCE]: 'Persistence' }
  const few = rows.length < 4
  // Leave room between date labels: about 10 on a wide chart, 5 on a phone.
  const every = Math.max(1, Math.ceil(rows.length / (wide ? 10 : 5)))
  const series = [
    ...record.models.map((m, i) => ({ key: m.model, color: MODEL_COLORS[theme][m.model] ?? colors.model, dash: DASHES[i % DASHES.length], width: 2 })),
    { key: PERSISTENCE, color: MODEL_COLORS[theme].baseline, dash: '4 4', width: 3 },
  ]
  return (
    <>
      <div className="r-sunken p-1">
        <Chart
          rows={rows}
          colors={colors}
          height={wide ? 240 : 200}
          top={12}
          yWidth={48}
          xTicks={rows.flatMap((r, i) => (i % every === 0 ? [{ at: i, label: dayLabel(r.date) }] : []))}
          y={{ domain: [0, 'auto'], format: (v) => v.toFixed(target === 'precipitation' ? 2 : 1) }}
          series={series.map((s) => ({
            type: 'line' as const,
            key: s.key,
            value: (r: (typeof rows)[number]) => (r as unknown as Record<string, number | undefined>)[s.key],
            color: s.color,
            width: s.width,
            dash: s.dash || undefined,
            curve: 'linear' as const,
            dots: few,
            connectGaps: true,
          }))}
          tooltip={(r) => (
            <div className="r-tooltip tabular-nums">
              <div>{dayLabel(r.date)} (UTC)</div>
              {series.map((s) => {
                const v = (r as unknown as Record<string, number | undefined>)[s.key]
                return v === undefined ? null : (
                  <div key={s.key}>
                    {names[s.key]}: MAE {fmt(v, 3)} {TARGET_UNITS[target]}
                  </div>
                )
              })}
            </div>
          )}
          label={`Live track record by day, ${TARGET_LABELS[target].toLowerCase()}`}
        />
      </div>
      <ul className="m-0 mt-2 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[0.92em]">
        {series.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <svg width="26" height="10" aria-hidden="true">
              <line x1="0" y1="5" x2="26" y2="5" stroke={s.color} strokeWidth={s.width} strokeDasharray={s.dash} />
            </svg>
            {names[s.key]}
          </li>
        ))}
      </ul>
    </>
  )
}

/**
 * Accuracy city by city. A city's numbers appear only once it has enough different days scored
 * (min_days_per_city); until then it shows how far along it is, so a few days of one city's
 * weather are never presented as that city's accuracy.
 */
function ByCity({ record, models, target, digits, unit }: { record: TrackRecord; models: ModelMetrics[]; target: Target; digits: number; unit: string }) {
  const need = record.min_days_per_city
  const cities = models[0]?.data.cities ?? []
  const names = Object.fromEntries(record.models.map((m) => [m.model, m.display_name]))
  const ready = cities.filter((c) => (record.city_days[c.id] ?? 0) >= need).length
  return (
    <>
      <Table
        caption={`${TARGET_LABELS[target]}: live accuracy by city`}
        head={['City', 'Days scored', 'Most accurate model here', `Its MAE (${unit})`, `Persistence MAE (${unit})`]}
        rows={cities.map((c) => {
          const days = record.city_days[c.id] ?? 0
          if (days < need) return [c.name, `${days} of ${need}`, 'Not enough days yet', '–', '–']
          const rows = record.by_city.filter((b) => b.city === c.id && b.target === target)
          if (rows.length === 0) return [c.name, `${days}`, 'No scores for this measure', '–', '–']
          const best = rows.reduce((a, b) => (b.mae < a.mae ? b : a))
          return [c.name, `${days}`, names[best.model] ?? best.model, fmt(best.mae, digits), fmt(best.persistence_mae, digits)]
        })}
      />
      <p className="m-0 mt-1 mb-3 max-w-[75ch] text-[0.92em] text-[var(--text-muted)]">
        {ready === 0
          ? `No city has ${need} days of scores in this period yet, so no city's accuracy is shown: a few days of one place's weather say little about a model. `
          : `Cities appear once they have ${need} different days of scores in the chosen period. `}
        &quot;Most accurate&quot; is simply the lowest error here so far, not a model chosen for that city.
      </p>
    </>
  )
}

export function TrackRecordPanel({ models, target, theme }: { models: ModelMetrics[]; target: Target; theme: Theme }) {
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30)
  const record = useResource(`track:${days}`, ({ signal }) => getTrackRecord(days, signal))
  const unit = TARGET_UNITS[target]
  const digits = target === 'precipitation' ? 3 : 2

  const picker = (
    <div className="mb-2 flex flex-wrap gap-1.5" role="group" aria-label="Period">
      {WINDOWS.map((d) => (
        <Button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>
          Last {d} days
        </Button>
      ))}
    </div>
  )

  if (!record.data) {
    return record.status === 'error' ? <BackendNotice message={record.error?.message} onRetry={record.reload} /> : (
      <div className="flex flex-col gap-2">
        <TextSkeleton lines={2} />
        <TableSkeleton rows={6} columns={4} />
      </div>
    )
  }
  const r = record.data
  const every = r.interval_hours > 0 ? `Every ${r.interval_hours} hours the server` : 'The server'
  const intro = (
    <p className="m-0 mb-2 max-w-[75ch]">
      {every} issues a 24-hour forecast from each model for all {models[0]?.data.cities.length ?? 10} trained cities, and keeps the forecasts
      people open on the Forecast page too. Once an hour is {r.settle_hours} hours in the past, every forecast for it is scored. {r.source}
    </p>
  )

  const totals = r.totals.filter((t) => t.target === target)
  if (totals.length === 0) {
    return (
      <>
        {intro}
        {picker}
        <p className="m-0 max-w-[75ch]">
          Nothing has been scored in the last {days} days yet. A forecast can be scored about {24 + r.settle_hours} hours after it is issued, once
          all 24 of its hours have passed and settled.{r.pending_points > 0 && ` ${r.pending_points.toLocaleString()} forecast values are waiting.`}
        </p>
      </>
    )
  }

  const stat = (model: string, rows: TrackStats[]) => rows.find((t) => t.model === model)
  const spanDays = r.first_valid_at && r.last_valid_at ? (Date.parse(r.last_valid_at) - Date.parse(r.first_valid_at)) / 86_400_000 : 0
  return (
    <>
      {intro}
      {picker}
      <p className="m-0 mb-2 max-w-[75ch] tabular-nums">
        {r.runs.toLocaleString()} forecasts for {r.cities} {r.cities === 1 ? 'city' : 'cities'}, scored hours from {r.first_valid_at && dateTime(r.first_valid_at)} to{' '}
        {r.last_valid_at && dateTime(r.last_valid_at)}. {r.pending_points.toLocaleString()} forecast values are still waiting for their hour to pass.
      </p>
      {spanDays < 7 && (
        <p className="m-0 mb-2 max-w-[75ch]">
          <strong>Early days:</strong> this covers less than a week, and a single week's weather can make any model look better or worse than it is. The
          test-period column is the steadier figure until this record has several weeks.
        </p>
      )}
      <Table
        caption={`${TARGET_LABELS[target]}: live track record`}
        head={['Model', `MAE (${unit})`, `Persistence MAE (${unit})`, 'MAE vs persistence', 'Inside range', 'Hours scored', `Test-period MAE (${unit})`]}
        rows={r.models.flatMap((m) => {
          const t = stat(m.model, totals)
          if (!t) return []
          const test = models.find((x) => x.model === m.model)?.test[target].mae
          return [[m.display_name, fmt(t.mae, digits), fmt(t.persistence_mae, digits), improvement(t.mae, t.persistence_mae), `${(t.coverage * 100).toFixed(0)}%`, t.n.toLocaleString(), test === undefined ? '–' : fmt(test, digits)]]
        })}
      />
      <p className="m-0 mt-1 mb-3 max-w-[75ch] text-[0.92em] text-[var(--text-muted)]">
        {r.baseline} "Inside range" is how often what happened fell inside the model's {Math.round((models[0]?.interval.level ?? 0.8) * 100)}% range.
      </p>
      <DailyChart record={r} target={target} theme={theme} />
      <p className="m-0 mt-1 mb-3 text-[0.92em] text-[var(--text-muted)]">Mean absolute error per day (UTC) of the hours being forecast, {TARGET_LABELS[target].toLowerCase()} ({unit}).</p>
      <ByCity record={r} models={models} target={target} digits={digits} unit={unit} />
      <Table
        caption={`${TARGET_LABELS[target]}: live error by hours ahead`}
        head={['Model', ...LEADS.map((l) => `${l} h ahead`)]}
        rows={r.models.map((m) => [
          m.display_name,
          ...LEADS.map((l) => {
            const t = r.by_lead.find((b) => b.model === m.model && b.target === target && b.lead === l)
            return t ? fmt(t.mae, digits) : '–'
          }),
        ])}
      />
    </>
  )
}
