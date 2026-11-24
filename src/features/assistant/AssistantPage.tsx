import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Button, GroupBox, MessageBox, TextSkeleton } from '../../components/retro'
import { getClientId } from '../../hooks/useSavedPlaces'
import { useResource } from '../../hooks/useResource'
import { isAbort, toApiError } from '../../lib/api/http'
import { askAssistant, getAssistantStatus, type AssistantTurn } from '../../lib/api/weatherai'
import { placeShortLabel } from '../../lib/format'
import { HAS_SERVER, NO_SERVER_MESSAGE } from '../../lib/site'
import type { Place } from '../../types/weather'

// The server keeps no chat history; the page sends the recent turns with each question.
const HISTORY_TURNS = 10
const MAX_QUESTION = 500

interface ChatEntry extends AssistantTurn {
  sources?: string[]
}

function suggestions(place: Place): string[] {
  const here = placeShortLabel(place)
  return [
    `Will it rain in ${here} tomorrow?`,
    `What does Wetcast's own model expect in ${here} over the next 24 hours?`,
    `Are there any official weather warnings for ${here}?`,
    'How accurate are Wetcast’s models?',
  ]
}

// Ask page: a chat with the weather assistant about the current place.
export function AssistantPage({ place }: { place: Place }) {
  const status = useResource('assistant-status', ({ signal }) => getAssistantStatus(signal))
  const [chat, setChat] = useState<ChatEntry[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [clientId] = useState(getClientId)
  const controller = useRef<AbortController | null>(null)
  const logEnd = useRef<HTMLDivElement>(null)

  useEffect(() => () => controller.current?.abort(), [])
  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [chat, busy])

  const configured = status.data?.configured ?? false

  async function send(question: string) {
    const text = question.trim().slice(0, MAX_QUESTION)
    if (!text || busy) return
    const next: ChatEntry[] = [...chat, { role: 'user', content: text }]
    setChat(next)
    setDraft('')
    setError(null)
    setBusy(true)
    controller.current?.abort()
    controller.current = new AbortController()
    try {
      const turns = next.slice(-HISTORY_TURNS).map(({ role, content }) => ({ role, content }))
      // The history sent must start with a question.
      while (turns.length && turns[0].role !== 'user') turns.shift()
      const reply = await askAssistant(
        clientId,
        turns,
        { name: placeShortLabel(place), latitude: place.latitude, longitude: place.longitude, country_code: place.countryCode },
        controller.current.signal,
      )
      setChat((c) => [...c, { role: 'assistant', content: reply.reply, sources: reply.sources }])
    } catch (e) {
      if (isAbort(e)) return
      setError(toApiError(e).message)
      setChat((c) => c.slice(0, -1)) // take the unanswered question back off the log
      setDraft(text)
    } finally {
      setBusy(false)
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    void send(draft)
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send(draft)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <GroupBox title="Ask Javed">
        <p className="m-0 mb-2 max-w-[75ch]">
          Ask about the weather in {placeShortLabel(place)} or anywhere else. Javed is Wetcast&apos;s AI weather assistant: for every question it looks up Open-Meteo&apos;s forecast,
          Wetcast&apos;s own models and official warnings, and answers only from what it finds.{' '}
          {status.data?.provider === 'local'
            ? `It runs on ${status.data.model}, a small free model on Wetcast's own computer, so it is slower and makes more mistakes than a large model: check the numbers against the Dashboard. `
            : ''}
          Answers can still be wrong, so for anything dangerous, follow your national weather service.
        </p>

        {status.status === 'loading' && <TextSkeleton lines={3} />}
        {status.status === 'error' && !HAS_SERVER && (
          <MessageBox kind="info" title="Javed runs on the full setup">
            {NO_SERVER_MESSAGE}
          </MessageBox>
        )}
        {status.status === 'error' && HAS_SERVER && (
          <MessageBox kind="warning" title="Javed isn't reachable">
            Wetcast&apos;s server isn&apos;t responding, so questions can&apos;t be answered right now.
          </MessageBox>
        )}
        {status.data && !configured && (
          <div className="r-sunken" style={{ background: 'var(--face)' }}>
            <MessageBox kind="info" title="Javed isn't switched on on this server">
              It needs Ollama running on the server&apos;s computer with its free local model installed. Everything else in Wetcast works
              without it. The README explains how to switch it on.
            </MessageBox>
          </div>
        )}

        {configured && (
          <>
            <div className="r-sunken mb-2 max-h-[55vh] min-h-[160px] overflow-y-auto p-2" style={{ background: 'var(--field)' }} aria-live="polite" aria-busy={busy}>
              {chat.length === 0 && !busy && <p className="m-0 text-[var(--text-muted)]">Pick a question below or type your own.</p>}
              <ol className="m-0 flex list-none flex-col gap-2 p-0">
                {chat.map((m, i) => (
                  <li key={i} className={m.role === 'user' ? 'self-end' : 'self-start'} style={{ maxWidth: 'min(62ch, 92%)' }}>
                    <div className="mb-0.5 text-[0.85em] font-bold">{m.role === 'user' ? 'You' : 'Javed'}</div>
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
                      <div className="mt-0.5 text-[0.85em] text-[var(--text-muted)]">Looked up: {m.sources.join(' · ')}</div>
                    )}
                  </li>
                ))}
                {busy && (
                  <li className="self-start" role="status">
                    <div className="mb-0.5 text-[0.85em] font-bold">Javed</div>
                    <div className="px-2 py-1.5 text-[var(--text-muted)]" style={{ background: 'var(--face)', border: '1px solid var(--shadow)' }}>
                      Looking up the data…
                    </div>
                  </li>
                )}
              </ol>
              <div ref={logEnd} />
            </div>

            {error && (
              <div className="r-sunken mb-2" style={{ background: 'var(--face)' }}>
                <MessageBox kind="warning" role="alert" title="No answer this time">
                  {error}
                </MessageBox>
              </div>
            )}

            <form onSubmit={onSubmit} className="flex flex-col gap-1.5 sm:flex-row sm:items-end">
              <label className="sr-only" htmlFor="assistant-question">
                Your question
              </label>
              <textarea
                id="assistant-question"
                className="r-input min-h-[44px] flex-1 resize-y"
                rows={2}
                maxLength={MAX_QUESTION}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Ask Javed about the weather. Enter sends, Shift+Enter starts a new line."
                disabled={busy}
              />
              <div className="flex gap-1.5">
                <Button type="submit" disabled={busy || !draft.trim()}>
                  Ask
                </Button>
                <Button type="button" onClick={() => setChat([])} disabled={busy || chat.length === 0}>
                  Clear chat
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
              Up to {status.data?.daily_limit_per_visitor} questions a day.{' '}
              Your questions go only to Wetcast&apos;s server, where Javed answers them; the chat is not saved.
            </p>
          </>
        )}
      </GroupBox>
    </div>
  )
}
