import { useCallback, useEffect, useRef, useState } from 'react'
import { toVoiceError, type VoiceError } from '../lib/speechHelp'

/**
 * Voice input through the browser's speech recognition (Web Speech API).
 * Available in Chrome, Edge and Safari; not in Firefox. It needs a secure page
 * (https or localhost) and microphone permission. In Chrome and Edge the audio
 * is processed by the browser maker's speech service, not by WeatherAI.
 */
interface RecognitionResultEvent {
  results: ArrayLike<ArrayLike<{ transcript: string }>>
}

interface RecognitionErrorEvent {
  error: string
}

interface Recognition {
  lang: string
  interimResults: boolean
  maxAlternatives: number
  continuous: boolean
  onresult: ((event: RecognitionResultEvent) => void) | null
  onerror: ((event: RecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

type RecognitionConstructor = new () => Recognition

function getRecognition(): RecognitionConstructor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export type { VoiceError }

export function useSpeechRecognition() {
  const supported = getRecognition() !== null && typeof window !== 'undefined' && window.isSecureContext
  const [listening, setListening] = useState(false)
  const current = useRef<Recognition | null>(null)

  const stop = useCallback(() => {
    current.current?.stop()
  }, [])

  const listen = useCallback(
    (onText: (text: string) => void, onError: (error: VoiceError) => void) => {
      const Ctor = getRecognition()
      if (!Ctor) return
      current.current?.abort()
      const recognition = new Ctor()
      recognition.lang = navigator.language || 'en-IN'
      recognition.interimResults = false
      recognition.maxAlternatives = 1
      recognition.continuous = false
      recognition.onresult = (event) => {
        const text = event.results[0]?.[0]?.transcript ?? ''
        if (text.trim()) onText(text)
      }
      recognition.onerror = (event) => onError(toVoiceError(event.error))
      recognition.onend = () => {
        setListening(false)
        if (current.current === recognition) current.current = null
      }
      current.current = recognition
      setListening(true)
      try {
        recognition.start()
      } catch {
        setListening(false)
        onError('other')
      }
    },
    [],
  )

  useEffect(() => () => current.current?.abort(), [])

  return { supported, listening, listen, stop }
}
