import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Button, GroupBox } from '../../components/retro'
import { isAbort } from '../../lib/api/http'
import { getAirQuality, getForecast, getWeekForecast, searchPlaces } from '../../lib/api/openMeteo'
import { getModels, getPredictions } from '../../lib/api/weatherai'
import { placeShortLabel } from '../../lib/format'
import { useFormat } from '../../lib/units'
import type { Place } from '../../types/weather'
import { choosePlace, composeAnswer, HELP_TEXT, isSamePlace, needs, parseQuestion, placeSearchNames, type AnswerData } from './quickAnswers'

const MAX_QUESTION = 300

interface Entry {
  role: 'user' | 'answer'
  content: string
  sources?: string[]
}

// Starter questions for the place on screen.
function suggestions(place: Place): string[] {
  const here = placeShortLabel(place)
  return [
    `Will it rain in ${here} tomorrow?`,
    `What's the weather in ${here} this week?`,
    `What does Wetcast's own model expect in ${here}?`,
    'How accurate are Wetcast’s models?',
  ]
}

// The value of a settled request, or undefined when it failed.
function valueOf<T>(result: PromiseSettledResult<T> | undefined): T | undefined {
  return result?.status === 'fulfilled' ? result.value : undefined
}

// Ask page on the public copy: simple weather questions answered by fixed rules, in the browser.
export function QuickAsk({ place }: { place: Place }) {
  const fmt = useFormat()
  const [chat, setChat] = useState<Entry[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const logEnd = useRef<HTMLDivElement>(null)

  useEffect(() => () => controller.current?.abort(), [])
  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [chat, busy])

  // Works out the answer to one question: which place, which data, then the words.
  async function answer(question: string, signal: AbortSignal): Promise<Entry> {
    const parsed = parseQuestion(question)
    if (!parsed.topic) return { role: 'answer', content: HELP_TEXT }

    let target = place
    // The place's own name, or with its country when it was searched for ("Leh, India").
    let where = place.name
    if (parsed.place && !isSamePlace(parsed.place, place)) {
      let found: Place | undefined
      for (const name of placeSearchNames(parsed.place)) {
        found = choosePlace(await searchPlaces(name, { signal }), name, place)
        if (found) break
      }
      if (!found) return { role: 'answer', content: `I couldn't find a place called ${parsed.place}. Check the spelling, or pick it with the city search above.` }
      target = found
      where = placeShortLabel(found)
    }

    const need = needs(parsed.topic)
    const [forecast, week, air, predictions, models] = await Promise.allSettled([
      need.weather ? getForecast(target, { signal }) : Promise.resolve(undefined),
      need.weather || need.predictions ? getWeekForecast(target, { signal }) : Promise.resolve(undefined),
      need.air ? getAirQuality(target, { signal }) : Promise.resolve(undefined),
      need.predictions ? getPredictions(target.latitude, target.longitude, signal) : Promise.resolve(undefined),
      need.models ? getModels(signal) : Promise.resolve(undefined),
    ])
    if (signal.aborted) throw new DOMException('Request cancelled', 'AbortError')
    const data: AnswerData = {
      place: target,
      forecast: valueOf(forecast),
      week: valueOf(week),
      air: valueOf(air),
      predictions: valueOf(predictions),
      models: valueOf(models),
    }
    const reply = composeAnswer(parsed, data, where, fmt)
    return { role: 'answer', content: reply.text, sources: reply.sources }
  }

  // Adds the question to the log and its answer when it is ready.
  async function send(question: string) {
    const text = question.trim().slice(0, MAX_QUESTION)
    if (!text || busy) return
    setChat((c) => [...c, { role: 'user', content: text }])
    setDraft('')
    setBusy(true)
    controller.current?.abort()
    controller.current = new AbortController()
    try {
      const reply = await answer(text, controller.current.signal)
      setChat((c) => [...c, reply])
    } catch (e) {
      if (isAbort(e)) return
      setChat((c) => [...c, { role: 'answer', content: "The weather data couldn't be loaded just now. Check your connection and try again." }])
    } finally {
      setBusy(false)
    }
  }

  // Sends the draft when the form is submitted.
  function onSubmit(e: FormEvent) {
    e.preventDefault()
    void send(draft)
  }

  // Enter sends the draft; Shift+Enter makes a new line.
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send(draft)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <GroupBox title="Ask Wetcast">
        <p className="m-0 mb-2 max-w-[75ch]">
          Ask a simple question about the weather in {placeShortLabel(place)} or anywhere else: rain, temperature, wind, humidity, UV, sunrise and
          sunset, air quality, or Wetcast&apos;s own models. Answers come from Open-Meteo&apos;s forecast and Wetcast&apos;s model forecasts, worked out by
          fixed rules in your browser. For anything dangerous, follow your national weather service.
        </p>

        <div className="r-sunken mb-2 max-h-[55vh] min-h-[160px] overflow-y-auto p-2" style={{ background: 'var(--field)' }} aria-live="polite" aria-busy={busy}>
          {chat.length === 0 && !busy && <p className="m-0 text-[var(--text-muted)]">Pick a question below or type your own.</p>}
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {chat.map((m, i) => (
              <li key={i} className={m.role === 'user' ? 'self-end' : 'self-start'} style={{ maxWidth: 'min(62ch, 92%)' }}>
                <div className="mb-0.5 text-[0.85em] font-bold">{m.role === 'user' ? 'You' : 'Wetcast'}</div>
                <div
                  className="whitespace-pre-line px-2 py-1.5"
                  style={
                    m.role === 'user'
                      ? { background: 'var(--select)', color: 'var(--select-text)' }
                      : { background: 'var(--face)', border: '1px solid var(--shadow)' }
                  }
                >
                  {m.content}
                </div>
                {m.sources && m.sources.length > 0 && (
                  <div className="mt-0.5 text-[0.85em] text-[var(--text-muted)]">From: {m.sources.join(' · ')}</div>
                )}
              </li>
            ))}
            {busy && (
              <li className="self-start" role="status">
                <div className="mb-0.5 text-[0.85em] font-bold">Wetcast</div>
                <div className="px-2 py-1.5 text-[var(--text-muted)]" style={{ background: 'var(--face)', border: '1px solid var(--shadow)' }}>
                  Looking up the forecast…
                </div>
              </li>
            )}
          </ol>
          <div ref={logEnd} />
        </div>

        <form onSubmit={onSubmit} className="flex flex-col gap-1.5 sm:flex-row sm:items-end">
          <label className="sr-only" htmlFor="quick-question">
            Your question
          </label>
          <textarea
            id="quick-question"
            className="r-input min-h-[44px] flex-1 resize-y"
            rows={2}
            maxLength={MAX_QUESTION}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="For example: Will it rain in Jaipur tomorrow? Enter sends, Shift+Enter starts a new line."
            disabled={busy}
          />
          <div className="flex gap-1.5">
            <Button type="submit" disabled={busy || !draft.trim()}>
              Ask
            </Button>
            <Button type="button" onClick={() => setChat([])} disabled={busy || chat.length === 0}>
              Clear
            </Button>
          </div>
        </form>

        <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Suggested questions">
          {suggestions(place).map((q) => (
            <Button key={q} type="button" onClick={() => void send(q)} disabled={busy}>
              {q}
            </Button>
          ))}
        </div>
        <p className="m-0 mt-2 text-[0.92em] text-[var(--text-muted)]">
          Nothing you type is stored. A place you name is looked up with Open-Meteo&apos;s place search. Javed, Wetcast&apos;s assistant that understands
          any question, needs the Wetcast server, so it runs on the full setup described in the README.
        </p>
      </GroupBox>
    </div>
  )
}
