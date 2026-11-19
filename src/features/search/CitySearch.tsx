import { useEffect, useId, useState, type KeyboardEvent } from 'react'
import { isAbort } from '../../lib/api/http'
import { searchPlaces } from '../../lib/api/openMeteo'
import type { Place } from '../../types/weather'

type Status = 'idle' | 'searching' | 'done' | 'error'

/** City search as an ARIA 1.2 combobox, backed by Open-Meteo geocoding. */
interface CitySearchProps {
  onSelect: (place: Place) => void
  label?: string
  placeholder?: string
}

export function CitySearch({ onSelect, label = 'Search for a city', placeholder = 'Search city' }: CitySearchProps) {
  const id = useId()
  const listId = `${id}-list`
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [rawResults, setResults] = useState<Place[]>([])
  const [rawStatus, setStatus] = useState<Status>('idle')
  const [active, setActive] = useState(-1)

  const trimmed = query.trim()
  const searchable = trimmed.length >= 2
  const results = searchable ? rawResults : []
  const status: Status = searchable ? rawStatus : 'idle'

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      searchPlaces(q, { signal: controller.signal })
        .then((found) => {
          setResults(found)
          setActive(found.length > 0 ? 0 : -1)
          setStatus('done')
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || isAbort(error)) return
          setStatus('error')
        })
    }, 300)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  function choose(place: Place) {
    onSelect(place)
    setQuery('')
    setOpen(false)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' && results.length > 0) {
      event.preventDefault()
      setOpen(true)
      setActive((i) => (i + 1) % results.length)
    } else if (event.key === 'ArrowUp' && results.length > 0) {
      event.preventDefault()
      setOpen(true)
      setActive((i) => (i <= 0 ? results.length - 1 : i - 1))
    } else if (event.key === 'Enter' && open && active >= 0 && results[active]) {
      event.preventDefault()
      choose(results[active])
    } else if (event.key === 'Escape') {
      setOpen(false)
    }
  }

  const showList = open && results.length > 0
  const message =
    !open || !searchable
      ? null
      : status === 'searching' && results.length === 0
        ? 'Searching…'
        : status === 'error'
          ? "Search isn't available right now. Try again in a moment."
          : status === 'done' && results.length === 0
            ? `No places match "${trimmed}". Check the spelling or try a nearby city.`
            : null

  return (
    <div className="relative min-w-0 flex-1 basis-[220px]">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        id={id}
        type="search"
        role="combobox"
        autoComplete="off"
        spellCheck={false}
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
        placeholder={placeholder}
        className="r-input w-full"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
          if (e.target.value.trim().length >= 2) setStatus('searching')
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      <ul id={listId} role="listbox" aria-label="Matching places" className={`r-listbox absolute inset-x-0 top-full z-20 mt-0.5 max-h-72 overflow-auto ${showList ? '' : 'hidden'}`}>
        {results.map((place, i) => (
          <li
            key={place.id}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            className="r-option"
            onMouseDown={(e) => {
              e.preventDefault()
              choose(place)
            }}
            onMouseEnter={() => setActive(i)}
          >
            {place.name}
            <span className={i === active ? '' : 'text-[var(--text-muted)]'}>
              {[place.admin1, place.country].filter(Boolean).length > 0 && `, ${[place.admin1, place.country].filter(Boolean).join(', ')}`}
            </span>
          </li>
        ))}
      </ul>
      <div role="status" className={message ? 'r-listbox absolute inset-x-0 top-full z-20 mt-0.5 px-1.5 py-1' : 'sr-only'}>
        {message}
      </div>
    </div>
  )
}
