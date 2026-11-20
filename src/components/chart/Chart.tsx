import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { CHART_FONT } from '../../lib/chartTheme'
import { isNum, linearPath, monotonePath, nearestIndex, niceScale, segments, type Num } from './chartMath'

/**
 * WeatherAI's SVG chart: lines, dithered bands and bars over evenly spaced rows (or a
 * numeric x axis), with a hover / touch / keyboard cursor and tooltip. It replaces a
 * general charting library at a fraction of the size, and draws crisp 1-pixel retro
 * axes. Charts stay decorative for screen readers: every chart in the app has a table
 * or text alternative next to it.
 */

export type Series<R> =
  | {
      type: 'line'
      key: string
      value: (r: R) => Num
      color: string
      width?: number
      dash?: string
      curve?: 'monotone' | 'linear'
      dots?: boolean
      /** Draw straight on across missing values instead of breaking the line. */
      connectGaps?: boolean
    }
  | { type: 'band'; key: string; lower: (r: R) => Num; upper: (r: R) => Num; color: string; opacity?: number }
  | { type: 'bars'; key: string; value: (r: R) => Num; color: string | ((r: R, i: number) => string); stack?: string }

export interface ChartColors {
  text: string
  axis: string
  grid: string
}

export interface ChartProps<R> {
  rows: R[]
  series: Series<R>[]
  colors: ChartColors
  height: number
  /** Numeric x positions (e.g. hours ahead) and their domain; otherwise rows are evenly spaced categories. */
  x?: { value: (r: R, i: number) => number; domain: [number, number] }
  /** Tick marks on the x axis: at a row index (category axis) or an x value (numeric axis). */
  xTicks: { at: number; label: string }[]
  /** Rotate x labels (degrees, negative = slant up to the left) when they're long. */
  xTickAngle?: number
  y?: { domain?: [number | 'auto', number | 'auto']; format?: (v: number) => string; ticks?: number }
  /** Vertical marker lines, positioned like xTicks. */
  markers?: { at: number; label?: string }[]
  /** Content for the tooltip of the row under the cursor; omit for no tooltip. */
  tooltip?: (row: R, index: number) => ReactNode
  /** Label used for keyboard users when the chart has a tooltip. */
  label?: string
  /** A sentence or two saying what the chart shows (e.g. lowest and highest), read out by screen readers. */
  summary?: string
  yWidth?: number
  top?: number
  /** Gap between bars as a share of the slot (bars only). */
  barGap?: number
}

const RIGHT = 8

export function Chart<R>({
  rows,
  series,
  colors,
  height,
  x,
  xTicks,
  xTickAngle = 0,
  y = {},
  markers = [],
  tooltip,
  label,
  summary,
  yWidth = 44,
  top = 14,
  barGap = 0.2,
}: ChartProps<R>) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [active, setActive] = useState<number | null>(null)
  const id = useId().replace(/:/g, '')

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setWidth(Math.floor(el.getBoundingClientRect().width))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Slanted labels need room below the axis: about 6.2 px per character at 11 px type.
  const longest = xTicks.reduce((m, t) => Math.max(m, t.label.length), 0)
  const bottom = xTickAngle ? Math.min(Math.ceil(longest * 6.2 * Math.sin((Math.abs(xTickAngle) * Math.PI) / 180)) + 16, 96) : 22
  const plotW = Math.max(width - yWidth - RIGHT, 10)
  const plotH = Math.max(height - top - bottom, 10)
  const n = rows.length

  // x positions: category slots (centre of each row's slot) or a numeric scale.
  const slot = n ? plotW / n : plotW
  const xs = useMemo(
    () =>
      rows.map((r, i) => (x ? yWidth + ((x.value(r, i) - x.domain[0]) / (x.domain[1] - x.domain[0] || 1)) * plotW : yWidth + slot * (i + 0.5))),
    [rows, x, yWidth, plotW, slot],
  )
  const xAt = (at: number) => (x ? yWidth + ((at - x.domain[0]) / (x.domain[1] - x.domain[0] || 1)) * plotW : yWidth + slot * (at + 0.5))

  // y scale from every value drawn (stacked bars use their totals).
  const scale = useMemo(() => {
    const values: number[] = []
    const stacks = new Map<string, number[]>()
    for (const s of series) {
      rows.forEach((r, i) => {
        if (s.type === 'line') {
          const v = s.value(r)
          if (isNum(v)) values.push(v)
        } else if (s.type === 'band') {
          const lo = s.lower(r)
          const hi = s.upper(r)
          if (isNum(lo)) values.push(lo)
          if (isNum(hi)) values.push(hi)
        } else {
          const v = s.value(r)
          if (!isNum(v)) return
          if (s.stack) {
            const totals = stacks.get(s.stack) ?? new Array(rows.length).fill(0)
            totals[i] += v
            stacks.set(s.stack, totals)
          } else values.push(v)
        }
      })
    }
    for (const totals of stacks.values()) values.push(...totals)
    if (series.some((s) => s.type === 'bars')) values.push(0)
    const min = values.length ? Math.min(...values) : 0
    const max = values.length ? Math.max(...values) : 1
    return niceScale(min, max, y.domain, y.ticks ?? 5)
  }, [rows, series, y.domain, y.ticks])

  const [d0, d1] = scale.domain
  const yAt = (v: number) => top + plotH - ((v - d0) / (d1 - d0 || 1)) * plotH
  const fmtY = y.format ?? ((v: number) => String(v))

  // Bars: stacked series share a running total per row (cheap enough to lay out on each render).
  const bars = (() => {
    const out: { key: string; x: number; y: number; w: number; h: number; fill: string }[] = []
    const barSeries = series.filter((s): s is Extract<Series<R>, { type: 'bars' }> => s.type === 'bars')
    if (!barSeries.length) return out
    const groups = new Map<string, typeof barSeries>()
    for (const s of barSeries) groups.set(s.stack ?? s.key, [...(groups.get(s.stack ?? s.key) ?? []), s])
    const groupList = [...groups.values()]
    const inner = slot * (1 - barGap)
    const w = Math.max(inner / groupList.length, 1)
    rows.forEach((r, i) => {
      groupList.forEach((group, g) => {
        let base = 0
        for (const s of group) {
          const v = s.value(r)
          if (!isNum(v) || v === 0) continue
          const y0 = yAt(base)
          const y1 = yAt(base + v)
          base += v
          const left = yWidth + slot * i + (slot - inner) / 2 + w * g
          out.push({
            key: `${s.key}-${i}`,
            x: left,
            y: Math.min(y0, y1),
            w: Math.max(w - (groupList.length > 1 ? 1 : 0), 1),
            h: Math.abs(y1 - y0),
            fill: typeof s.color === 'function' ? s.color(r, i) : s.color,
          })
        }
      })
    })
    return out
  })()

  const pick = (clientX: number) => {
    const el = box.current
    if (!el || !n) return
    const px = clientX - el.getBoundingClientRect().left
    setActive(nearestIndex(xs, px))
  }
  const onPointer = (e: PointerEvent<HTMLDivElement>) => tooltip && pick(e.clientX)
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!tooltip || !n) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const step = e.key === 'ArrowRight' ? 1 : -1
      setActive((a) => (a === null ? (step > 0 ? 0 : n - 1) : Math.min(Math.max(a + step, 0), n - 1)))
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      setActive(e.key === 'Home' ? 0 : n - 1)
    } else if (e.key === 'Escape') setActive(null)
  }

  const tick = { fill: colors.text, fontSize: 11, fontFamily: CHART_FONT }
  const activeX = active !== null ? xs[active] : null
  const tipLeft = activeX !== null && activeX > width - 190 ? undefined : (activeX ?? 0) + 12
  const tipRight = activeX !== null && activeX > width - 190 ? width - activeX + 12 : undefined

  return (
    <div
      ref={box}
      className="r-chart relative w-full touch-pan-y select-none outline-none"
      style={{ height }}
      onPointerMove={onPointer}
      onPointerDown={onPointer}
      onPointerLeave={(e) => e.pointerType === 'mouse' && setActive(null)}
      onBlur={() => setActive(null)}
      onKeyDown={onKey}
      tabIndex={tooltip ? 0 : undefined}
      role={tooltip ? 'group' : undefined}
      aria-label={tooltip ? `${label ?? 'Chart'}. Use the left and right arrow keys to read values.` : undefined}
      aria-describedby={summary ? `${id}-summary` : undefined}
    >
      {summary && (
        <p id={`${id}-summary`} className="sr-only">
          {summary}
        </p>
      )}
      {width > 0 && (
        <svg width={width} height={height} className="r-chart-svg block" aria-hidden="true">
          <defs>
            {series.map((s) =>
              s.type === 'band' ? (
                <pattern key={s.key} id={`${id}-${s.key}`} width="4" height="4" patternUnits="userSpaceOnUse">
                  <rect width="2" height="2" fill={s.color} />
                  <rect x="2" y="2" width="2" height="2" fill={s.color} />
                </pattern>
              ) : null,
            )}
          </defs>

          {/* grid and y axis */}
          <g shapeRendering="crispEdges">
            {scale.ticks.map((t) => (
              <line key={t} x1={yWidth} x2={yWidth + plotW} y1={Math.round(yAt(t)) + 0.5} y2={Math.round(yAt(t)) + 0.5} stroke={colors.grid} />
            ))}
            <line x1={yWidth + 0.5} x2={yWidth + 0.5} y1={top} y2={top + plotH} stroke={colors.axis} />
            <line x1={yWidth} x2={yWidth + plotW} y1={top + plotH + 0.5} y2={top + plotH + 0.5} stroke={colors.axis} />
          </g>
          {scale.ticks.map((t) => (
            <text key={t} x={yWidth - 6} y={yAt(t)} dy="0.32em" textAnchor="end" {...tick}>
              {fmtY(t)}
            </text>
          ))}

          {/* x ticks */}
          {xTicks.map((t) => {
            const px = Math.round(xAt(t.at)) + 0.5
            return (
              <g key={`${t.at}-${t.label}`}>
                <line x1={px} x2={px} y1={top + plotH} y2={top + plotH + 5} stroke={colors.axis} shapeRendering="crispEdges" />
                {xTickAngle ? (
                  <text x={px} y={top + plotH + 9} textAnchor="end" transform={`rotate(${xTickAngle} ${px} ${top + plotH + 9})`} dy="0.71em" {...tick}>
                    {t.label}
                  </text>
                ) : (
                  <text x={px} y={top + plotH + 9} textAnchor="middle" dy="0.71em" {...tick}>
                    {t.label}
                  </text>
                )}
              </g>
            )
          })}

          <g className="r-chart-data">
            {series.map((s) => {
              if (s.type !== 'band') return null
              const pts = rows.map((r, i) => [xs[i], s.lower(r), s.upper(r)] as const)
              const runs: (readonly [number, number, number])[][] = []
              let run: (readonly [number, number, number])[] = []
              for (const [px, lo, hi] of pts) {
                if (isNum(lo) && isNum(hi)) run.push([px, lo, hi])
                else if (run.length) {
                  runs.push(run)
                  run = []
                }
              }
              if (run.length) runs.push(run)
              return runs.map((r, k) => (
                <path
                  key={`${s.key}-${k}`}
                  d={`${linearPath(r.map(([px, , hi]) => [px, yAt(hi)]))}L${r
                    .slice()
                    .reverse()
                    .map(([px, lo]) => `${px.toFixed(1)},${yAt(lo).toFixed(1)}`)
                    .join('L')}Z`}
                  fill={`url(#${id}-${s.key})`}
                  opacity={s.opacity ?? 0.45}
                />
              ))
            })}
            {bars.map((b) => (
              <rect key={b.key} x={b.x} y={b.y} width={b.w} height={b.h} fill={b.fill} shapeRendering="crispEdges" />
            ))}
            {series.map((s) => {
              if (s.type !== 'line') return null
              const points = rows.map((r, i) => [xs[i], s.value(r)] as [number, Num])
              const runs = segments(s.connectGaps ? points.filter(([, v]) => isNum(v)) : points)
              return runs.map((run, k) => {
                const pts = run.map(([px, v]) => [px, yAt(v)] as [number, number])
                return (
                  <g key={`${s.key}-${k}`}>
                    <path
                      d={s.curve === 'linear' ? linearPath(pts) : monotonePath(pts)}
                      fill="none"
                      stroke={s.color}
                      strokeWidth={s.width ?? 2}
                      strokeDasharray={s.dash}
                      strokeLinejoin="round"
                    />
                    {s.dots && pts.map(([px, py]) => <circle key={px} cx={px} cy={py} r={3} fill={s.color} />)}
                  </g>
                )
              })
            })}
          </g>

          {markers.map((m) => {
            const px = Math.round(xAt(m.at)) + 0.5
            return (
              <g key={`m-${m.at}`}>
                <line x1={px} x2={px} y1={top} y2={top + plotH} stroke={colors.text} strokeDasharray="1 3" shapeRendering="crispEdges" />
                {m.label && (
                  <text x={px} y={top - 4} textAnchor="middle" {...tick}>
                    {m.label}
                  </text>
                )}
              </g>
            )
          })}

          {activeX !== null && active !== null && (
            <g pointerEvents="none">
              <line x1={Math.round(activeX) + 0.5} x2={Math.round(activeX) + 0.5} y1={top} y2={top + plotH} stroke={colors.axis} strokeDasharray="2 2" shapeRendering="crispEdges" />
              {series.map((s) => {
                if (s.type !== 'line') return null
                const v = s.value(rows[active])
                return isNum(v) ? <circle key={s.key} cx={activeX} cy={yAt(v)} r={3.5} fill={s.color} /> : null
              })}
            </g>
          )}
        </svg>
      )}
      {tooltip && active !== null && rows[active] !== undefined && (
        <div className="pointer-events-none absolute top-2 z-10" style={{ left: tipLeft, right: tipRight }}>
          {tooltip(rows[active], active)}
        </div>
      )}
    </div>
  )
}
