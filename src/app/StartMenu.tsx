import { Contrast, Ruler } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { loaders } from './pageLoaders'
import { PAGE_ICONS } from './pageIcons'
import { PAGES, type PageId } from './pages'
import { UnitsDialog } from './UnitsDialog'

interface StartMenuProps {
  page: PageId
  highContrast: boolean
  onToggleContrast: () => void
}

const preload = (id: PageId) => void loaders[id]().catch(() => undefined)

/**
 * The taskbar's Start button and its menu: every page plus high contrast. On phones it
 * replaces the menu bar, so the header stays short. A disclosure (button + list of links),
 * not an ARIA menu, because its items are ordinary page links.
 */
export function StartMenu({ page, highContrast, onToggleContrast }: StartMenuProps) {
  const [open, setOpen] = useState(false)
  const [unitsOpen, setUnitsOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      button.current?.focus()
    }
    const onFocus = (event: FocusEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    document.addEventListener('focusin', onFocus)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('focusin', onFocus)
    }
  }, [open])

  // Opening the menu is a strong hint a page change is coming: fetch the page code now.
  useEffect(() => {
    if (open) PAGES.forEach((p) => preload(p.id))
  }, [open])

  return (
    <div ref={root} className="relative shrink-0">
      <button
        ref={button}
        type="button"
        className="r-btn r-start-btn"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <img src="/favicon.svg" width={16} height={16} alt="" />
        <span>Start</span>
      </button>
      <div id={panelId} hidden={!open} className="r-raised r-start-menu">
        <div className="r-start-banner" aria-hidden="true">
          <span>
            <b>Weather</b>AI
          </span>
        </div>
        <div className="min-w-0 flex-1 py-[3px]">
          <nav aria-label="Pages (Start menu)">
            <ul className="m-0 list-none p-0">
              {PAGES.map((p) => {
                const Icon = PAGE_ICONS[p.id]
                return (
                  <li key={p.id}>
                    <a
                      href={`#/${p.id}`}
                      className="r-start-item"
                      aria-current={page === p.id ? 'page' : undefined}
                      onClick={() => setOpen(false)}
                    >
                      <Icon size={16} aria-hidden="true" />
                      {p.label}
                    </a>
                  </li>
                )
              })}
            </ul>
          </nav>
          <div className="r-divider mx-1 my-[3px]" />
          <button
            type="button"
            className="r-start-item w-full"
            aria-pressed={highContrast}
            onClick={() => {
              onToggleContrast()
              setOpen(false)
            }}
          >
            <Contrast size={16} aria-hidden="true" />
            High contrast{highContrast ? ': on' : ''}
          </button>
          <button
            type="button"
            className="r-start-item w-full"
            aria-haspopup="dialog"
            onClick={() => {
              setOpen(false)
              setUnitsOpen(true)
            }}
          >
            <Ruler size={16} aria-hidden="true" />
            Units…
          </button>
        </div>
      </div>
      {/* Outside the menu panel: the menu is hidden while the dialog is open. */}
      <UnitsDialog
        open={unitsOpen}
        onClose={() => {
          setUnitsOpen(false)
          button.current?.focus()
        }}
      />
    </div>
  )
}
