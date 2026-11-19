import { useCallback, useEffect, useState } from 'react'

/**
 * Text-to-speech through the browser's Web Speech API. Supported in current
 * Chrome, Edge, Safari and Firefox; `supported` is false elsewhere so the UI
 * can hide the control instead of showing a dead button.
 */
export function useSpeech() {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window
  const [speaking, setSpeaking] = useState(false)

  const stop = useCallback(() => {
    if (!supported) return
    window.speechSynthesis.cancel()
    setSpeaking(false)
  }, [supported])

  const speak = useCallback(
    (text: string) => {
      if (!supported) return
      window.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = 'en'
      utterance.rate = 1
      utterance.onend = () => setSpeaking(false)
      utterance.onerror = () => setSpeaking(false)
      setSpeaking(true)
      window.speechSynthesis.speak(utterance)
    },
    [supported],
  )

  useEffect(() => () => {
    if (supported) window.speechSynthesis.cancel()
  }, [supported])

  return { supported, speaking, speak, stop }
}
