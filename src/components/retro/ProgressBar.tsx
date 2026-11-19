interface ProgressBarProps {
  /** 0 to 100. */
  value: number
  label: string
  className?: string
}

/** Segmented progress bar, used here for probabilities. */
export function ProgressBar({ value, label, className = '' }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, value))
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      className={`r-progress ${className}`}
    >
      <div className="r-progress-fill" style={{ width: `${clamped}%` }} />
    </div>
  )
}
