import { Button } from '../components/retro'
import { useClock } from '../hooks/useClock'
import { localClock } from '../lib/format'

interface TaskbarProps {
  title: string
  minimized: boolean
  onToggleWindow: () => void
}

export function Taskbar({ title, minimized, onToggleWindow }: TaskbarProps) {
  const now = useClock()
  return (
    <footer
      className="r-raised fixed inset-x-0 bottom-0 z-30 flex items-center gap-2 px-1 py-[3px]"
      style={{ paddingBottom: 'max(3px, env(safe-area-inset-bottom))' }}
    >
      <Button
        aria-pressed={!minimized}
        aria-label={minimized ? `Restore ${title}` : `Minimise ${title}`}
        onClick={onToggleWindow}
        className="min-w-0 max-w-[70%] justify-start font-bold sm:max-w-[320px]"
        icon={<img src="/favicon.svg" width={16} height={16} alt="" />}
      >
        <span className="block truncate">{title}</span>
      </Button>
      <time className="r-status-field ml-auto tabular-nums" dateTime={now.toISOString()}>
        {localClock(now)}
      </time>
    </footer>
  )
}
