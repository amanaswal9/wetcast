import { Bell, Contrast, Moon, PanelTop, Ruler } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { loaders } from './pageLoaders'
import { PAGE_ICONS } from './pageIcons'
import { PAGES, type PageId } from './pages'
import { UnitsDialog } from './UnitsDialog'

interface StartMenuProps {
  page: PageId | null
  darkMode: boolean
  onToggleDark: () => void
  highContrast: boolean
  onToggleContrast: () => void
  warningNotifications: boolean
  onToggleNotifications: () => void
}

const preload = (id: PageId) => void loaders[id]().catch(() => undefined)

// Wetcast Mini in a small window of its own. Phones ignore the size and open a new tab,
// which is fine: there it is meant to be added to the home screen.
function openMini() {
  window.open('/mini/', 'wetcast-mini', 'popup,width=380,height=300')
}

// Underlined shortcut letter for each item; press it while the menu is open.
const PAGE_KEYS: Record<PageId, string> = {
  dashboard: 'd',
  forecast: 'f',
  map: 'm',
  assistant: 'a',
  analytics: 'n',
  models: 'o',
  locations: 'l',
  about: 'b',
}

// The label with its shortcut letter underlined, as in classic menus.
function KeyLabel({ text, letter }: { text: string; letter: string }) {
  const i = text.toLowerCase().indexOf(letter)
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <u>{text[i]}</u>
      {text.slice(i + 1)}
    </>
  )
}

// The taskbar's Start button and its menu: every page plus high contrast. On phones it
// replaces the menu bar, so the header stays short. A disclosure (button + list of links),
// not an ARIA menu, because its items are ordinary page links.
export function StartMenu({ page, darkMode, onToggleDark, highContrast, onToggleContrast, warningNotifications, onToggleNotifications }: StartMenuProps) {
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
      if (event.key === 'Escape') {
        setOpen(false)
        button.current?.focus()
        return
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return
      const items = [...(root.current?.querySelectorAll<HTMLElement>('.r-start-item') ?? [])]
      // Arrow keys move through the items (wrapping round), Home and End jump to the ends.
      const at = items.indexOf(document.activeElement as HTMLElement)
      const move = { ArrowDown: at + 1, ArrowUp: at < 0 ? items.length - 1 : at - 1, Home: 0, End: items.length - 1 }[event.key]
      if (move !== undefined) {
        event.preventDefault()
        items[(move + items.length) % items.length]?.focus()
        return
      }
      // A shortcut letter opens its item.
      const hit = items.find((item) => item.dataset.key === event.key.toLowerCase())
      if (hit) {
        event.preventDefault()
        hit.click()
      }
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
                      data-key={PAGE_KEYS[p.id]}
                      aria-keyshortcuts={PAGE_KEYS[p.id].toUpperCase()}
                      aria-current={page === p.id ? 'page' : undefined}
                      onClick={() => setOpen(false)}
                    >
                      <Icon size={16} aria-hidden="true" />
                      <span>
                        <KeyLabel text={p.label} letter={PAGE_KEYS[p.id]} />
                      </span>
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
            aria-pressed={darkMode}
            data-key="k"
            aria-keyshortcuts="K"
            onClick={() => {
              onToggleDark()
              setOpen(false)
            }}
          >
            <Moon size={16} aria-hidden="true" />
            <span>
              <KeyLabel text="Dark mode" letter="k" />
              {darkMode ? ': on' : ''}
            </span>
          </button>
          <button
            type="button"
            className="r-start-item w-full"
            aria-pressed={highContrast}
            data-key="h"
            aria-keyshortcuts="H"
            onClick={() => {
              onToggleContrast()
              setOpen(false)
            }}
          >
            <Contrast size={16} aria-hidden="true" />
            <span>
              <KeyLabel text="High contrast" letter="h" />
              {highContrast ? ': on' : ''}
            </span>
          </button>
          <button
            type="button"
            className="r-start-item w-full"
            data-key="i"
            aria-keyshortcuts="I"
            onClick={() => {
              setOpen(false)
              openMini()
            }}
          >
            <PanelTop size={16} aria-hidden="true" />
            <span>
              <KeyLabel text="Wetcast Mini" letter="i" />
            </span>
          </button>
          <button
            type="button"
            className="r-start-item w-full"
            aria-haspopup="dialog"
            data-key="u"
            aria-keyshortcuts="U"
            onClick={() => {
              setOpen(false)
              setUnitsOpen(true)
            }}
          >
            <Ruler size={16} aria-hidden="true" />
            <span>
              <KeyLabel text="Units…" letter="u" />
            </span>
          </button>
          <button
            type="button"
            className="r-start-item w-full"
            aria-pressed={warningNotifications}
            data-key="w"
            aria-keyshortcuts="W"
            onClick={() => {
              onToggleNotifications()
              setOpen(false)
            }}
          >
            <Bell size={16} aria-hidden="true" />
            <span>
              <KeyLabel text="Warning notifications" letter="w" />
              {warningNotifications ? ': on' : ''}
            </span>
          </button>
        </div>
      </div>
      <UnitsDialog
        // Rendered outside the menu panel, because the menu is hidden while the dialog is open.
        open={unitsOpen}
        onClose={() => {
          setUnitsOpen(false)
          button.current?.focus()
        }}
      />
    </div>
  )
}
