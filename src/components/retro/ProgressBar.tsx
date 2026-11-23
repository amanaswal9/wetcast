interface ProgressBarProps {
  // 0 to 100.
  value: number
  label: string
  className?: string
}

const BLOCKS = 20

// Segmented progress bar, like the classic Loading dialog: it fills in whole blocks (one per
// 5%), so the last block is never cut in half. Used for probabilities and loading progress.
export function ProgressBar({ value, label, className = '' }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, value))
  // Any non-zero value shows at least one block; 100% fills them all.
  const lit = clamped === 0 ? 0 : Math.max(1, Math.round((clamped / 100) * BLOCKS))
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      className={`r-progress ${className}`}
    >
      {Array.from({ length: BLOCKS }, (_, i) => (
        <span key={i} className="r-progress-block" data-lit={i < lit ? 'true' : undefined} />
      ))}
    </div>
  )
}
