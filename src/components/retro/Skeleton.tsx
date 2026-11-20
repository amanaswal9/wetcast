interface SkeletonProps {
  className?: string
  height?: number | string
}

/** Dithered placeholder block shown while data loads. */
export function Skeleton({ className = '', height = 16 }: SkeletonProps) {
  return <div aria-hidden="true" className={`r-skeleton ${className}`} style={{ height }} />
}

/*
 * Content-shaped placeholders: each one has the outline of what will replace it (a chart's
 * axes, a table's rows, lines of text), so the page keeps its shape and nothing jumps when
 * the data arrives. All are hidden from screen readers; the surrounding page announces loading.
 */

/** Placeholder for a chart: sunken frame, y-axis labels, gridlines and x-axis labels. */
export function ChartSkeleton({ height = 260, className = '' }: { height?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={`r-sunken p-1 ${className}`}>
      <div className="r-chart-skeleton" style={{ height: height - 8 }}>
        <div className="flex flex-col justify-between py-1">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} height={8} className="w-5" />
          ))}
        </div>
        <div className="r-chart-skeleton-plot" />
        <div />
        <div className="flex justify-between px-1">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} height={8} className="w-7" />
          ))}
        </div>
      </div>
    </div>
  )
}

/** Placeholder for a table: a header row and body rows, with the first column narrower. */
export function TableSkeleton({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div aria-hidden="true" className="r-sunken p-1.5">
      <div className="grid gap-x-3 gap-y-2" style={{ gridTemplateColumns: `minmax(0, 1.4fr) repeat(${columns - 1}, minmax(0, 1fr))` }}>
        {Array.from({ length: columns }, (_, i) => (
          <Skeleton key={`h${i}`} height={12} className="w-3/4" />
        ))}
        {Array.from({ length: rows * columns }, (_, i) => (
          <Skeleton key={i} height={10} className={i % columns === 0 ? 'w-full' : 'w-2/3'} />
        ))}
      </div>
    </div>
  )
}

/** Placeholder for a paragraph: full lines with a shorter last one. */
export function TextSkeleton({ lines = 2, className = '' }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={`flex max-w-[75ch] flex-col gap-1.5 py-0.5 ${className}`}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} height={10} className={i === lines - 1 ? 'w-2/3' : 'w-full'} />
      ))}
    </div>
  )
}
