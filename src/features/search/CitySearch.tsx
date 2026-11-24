import { Mic, MicOff } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { PageId } from '../../app/pages'
import { Button } from '../../components/retro'
import { useSpeechRecognition, type VoiceError } from '../../hooks/useSpeechRecognition'
import { isAbort } from '../../lib/api/http'
import { searchPlaces } from '../../lib/api/openMeteo'
import { voiceErrorMessage } from '../../lib/speechHelp'
import { parseVoiceCommand } from '../../lib/voice'
import type { Place } from '../../types/weather'

type Status = 'idle' | 'searching' | 'done' | 'error'

// City search as an ARIA 1.2 combobox, backed by Open-Meteo geocoding.
interface CitySearchProps {
  onSelect: (place: Place) => void
  label?: string
  placeholder?: string
  // Show a microphone button (where the browser supports speech recognition).
  voice?: boolean
  // Called when a spoken phrase names a page, e.g. "open the forecast".
  onVoicePage?: (page: PageId) => void
}

// True when two place names match, ignoring case, spaces and punctuation.
function sameName(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '')
  return n(a) === n(b)
}

// The search box with its list of matching places, and the microphone button when voice is on.
export function CitySearch({
  onSelect,
  label = 'Search for a city',
  placeholder = 'Search city',
  voice = false,
  onVoicePage,
}: CitySearchProps) {
  const id = useId()
  const listId = `${id}-list`
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [rawResults, setResults] = useState<Place[]>([])
  const [rawStatus, setStatus] = useState<Status>('idle')
  const [active, setActive] = useState(-1)
  const [voiceMessage, setVoiceMessage] = useState<string | null>(null)
  // Place name from the last voice command; if the top result matches it exactly, open it directly.
  const spokenPlace = useRef<string | null>(null)
  const onSelectRef = useRef(onSelect)
  const speech = useSpeechRecognition()

  useEffect(() => {
    onSelectRef.current = onSelect
  })

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
          const spoken = spokenPlace.current
          spokenPlace.current = null
          if (spoken && found[0] && sameName(found[0].name, spoken)) {
            // Spoken name matches the top result exactly: open it without another click.
            onSelectRef.current(found[0])
            setVoiceMessage(`Showing ${[found[0].name, found[0].admin1, found[0].country].filter(Boolean).join(', ')}.`)
            setQuery('')
            setOpen(false)
            return
          }
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

  function startVoice() {
    if (speech.listening) {
      speech.stop()
      return
    }
    setVoiceMessage('Listening… say a city, for example "weather in Jaipur".')
    speech.listen(
      (text) => {
        const command = parseVoiceCommand(text)
        if (command.page) onVoicePage?.(command.page)
        if (command.place) {
          spokenPlace.current = command.place
          setVoiceMessage(`Heard "${text}". Searching for ${command.place}…`)
          setQuery(command.place)
          setStatus('searching')
          setOpen(true)
          inputRef.current?.focus()
        } else if (command.page) {
          setVoiceMessage(`Heard "${text}". Opening that page.`)
        } else {
          setVoiceMessage(`Heard "${text}" but no place name. Try "weather in Delhi".`)
        }
      },
      (error: VoiceError) => setVoiceMessage(voiceErrorMessage(error, navigator.userAgent)),
    )
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

  const showVoice = voice && speech.supported

  return (
    <div className="flex min-w-0 flex-1 basis-[150px] gap-1.5 sm:basis-[220px]">
    <div className="relative min-w-0 flex-1">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        ref={inputRef}
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
          setVoiceMessage(null)
          spokenPlace.current = null
          if (e.target.value.trim().length >= 2) setStatus('searching')
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false)
          if (!speech.listening) setVoiceMessage(null)
        }}
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
      <div
        role="status"
        className={(message ?? (showList ? null : voiceMessage)) ? 'r-listbox absolute inset-x-0 top-full z-20 mt-0.5 px-1.5 py-1' : 'sr-only'}
      >
        {message ?? (showList ? null : voiceMessage)}
      </div>
    </div>
      {showVoice && (
        <Button
          aria-pressed={speech.listening}
          aria-label={speech.listening ? 'Stop listening' : 'Search by voice'}
          title={speech.listening ? 'Stop listening' : 'Search by voice'}
          onClick={startVoice}
          icon={speech.listening ? <MicOff size={14} /> : <Mic size={14} />}
          className="shrink-0 px-2.5"
        />
      )}
    </div>
  )
}
