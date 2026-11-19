interface SkeletonProps {
  className?: string
  height?: number | string
}

/** Dithered placeholder block shown while data loads. */
export function Skeleton({ className = '', height = 16 }: SkeletonProps) {
  return <div aria-hidden="true" className={`r-skeleton ${className}`} style={{ height }} />
}
