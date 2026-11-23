import { useCallback, useEffect, useRef, useState } from 'react'
import { pickVoice } from '../lib/speechHelp'

/**
 * Text-to-speech through the browser's Web Speech API. Supported in current
 * Chrome, Edge, Safari and Firefox; `supported` is false elsewhere so the UI
 * can hide the control instead of showing a dead button.
 *
 * Text is spoken one sentence at a time: Chrome stops long utterances after
 * about 15 seconds without firing `onend`, which would leave the button stuck.
 */
export function useSpeech() {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window
  const [speaking, setSpeaking] = useState(false)
  const run = useRef(0)

  const stop = useCallback(() => {
    if (!supported) return
    run.current += 1
    window.speechSynthesis.cancel()
    setSpeaking(false)
  }, [supported])

  const speak = useCallback(
    (text: string) => {
      if (!supported) return
      window.speechSynthesis.cancel()
      const id = ++run.current
      const sentences = text.match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text]
      setSpeaking(true)
      sentences.forEach((sentence, i) => {
        const utterance = new SpeechSynthesisUtterance(sentence)
        // Choose the voice ourselves: given only "en", some Mac browsers pick a novelty voice.
        const voice = pickVoice(window.speechSynthesis.getVoices(), navigator.language || 'en-IN')
        if (voice) utterance.voice = voice
        utterance.lang = voice?.lang ?? 'en'
        const finish = () => {
          if (run.current === id && i === sentences.length - 1) setSpeaking(false)
        }
        utterance.onend = finish
        utterance.onerror = () => {
          if (run.current === id) setSpeaking(false)
        }
        window.speechSynthesis.speak(utterance)
      })
    },
    [supported],
  )

  useEffect(() => () => {
    if (supported) window.speechSynthesis.cancel()
  }, [supported])

  return { supported, speaking, speak, stop }
}
