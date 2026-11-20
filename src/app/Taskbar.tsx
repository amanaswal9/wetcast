import { Button } from '../components/retro'
import { useClock } from '../hooks/useClock'
import { useFormat } from '../lib/units'
import { loaders } from './pageLoaders'
import { PAGE_ICONS, QUICK_LAUNCH } from './pageIcons'
import { PAGES, type PageId } from './pages'
import { StartMenu } from './StartMenu'

interface TaskbarProps {
  title: string
  page: PageId
  minimized: boolean
  onToggleWindow: () => void
  highContrast: boolean
  onToggleContrast: () => void
  warningNotifications: boolean
  onToggleNotifications: () => void
}

export function Taskbar({ title, page, minimized, onToggleWindow, highContrast, onToggleContrast, warningNotifications, onToggleNotifications }: TaskbarProps) {
  const now = useClock()
  const fmt = useFormat()
  return (
    <footer
      className="r-raised fixed inset-x-0 bottom-0 z-30 flex items-center gap-1 px-1 py-[3px] sm:gap-2"
      style={{
        paddingBottom: 'max(3px, env(safe-area-inset-bottom))',
        paddingLeft: 'max(4px, env(safe-area-inset-left))',
        paddingRight: 'max(4px, env(safe-area-inset-right))',
      }}
    >
      <StartMenu
        page={page}
        highContrast={highContrast}
        onToggleContrast={onToggleContrast}
        warningNotifications={warningNotifications}
        onToggleNotifications={onToggleNotifications}
      />
      {/* Quick launch: the three most-used pages, one tap away on phones (the menu bar covers wider screens). */}
      <nav aria-label="Quick launch" className="flex shrink-0 gap-0.5 sm:hidden">
        {QUICK_LAUNCH.map((id) => {
          const Icon = PAGE_ICONS[id]
          const label = PAGES.find((p) => p.id === id)?.label ?? id
          return (
            <a
              key={id}
              href={`#/${id}`}
              className="r-btn r-quick"
              aria-label={label}
              title={label}
              aria-current={page === id ? 'page' : undefined}
              onPointerDown={() => void loaders[id]().catch(() => undefined)}
            >
              <Icon size={16} aria-hidden="true" />
            </a>
          )
        })}
      </nav>
      <Button
        aria-pressed={!minimized}
        aria-label={minimized ? `Restore ${title}` : `Minimise ${title}`}
        onClick={onToggleWindow}
        className="min-w-0 flex-1 justify-start font-bold sm:max-w-[320px]"
        icon={<img src="/favicon.svg" width={16} height={16} alt="" />}
      >
        <span className="block truncate">{title}</span>
      </Button>
      <time className="r-status-field ml-auto shrink-0 tabular-nums" dateTime={now.toISOString()}>
        {fmt.clock(now)}
      </time>
    </footer>
  )
}
