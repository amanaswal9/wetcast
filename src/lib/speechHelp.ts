// Desktop-aware help for the browser's speech features (voice search and read-aloud), kept free of
// React so it can be tested. Works the same on Windows, macOS and Linux; the messages only name the
// right settings for the computer in use.

export type VoiceError = 'blocked' | 'no-mic' | 'service' | 'no-speech' | 'network' | 'other'

// Web Speech API error codes -> what the person can do about it.
export function toVoiceError(code: string): VoiceError {
  if (code === 'not-allowed') return 'blocked'
  if (code === 'audio-capture') return 'no-mic' // common on desktop PCs without a microphone
  if (code === 'service-not-allowed' || code === 'language-not-supported') return 'service'
  if (code === 'no-speech' || code === 'aborted') return 'no-speech'
  if (code === 'network') return 'network'
  return 'other'
}

type Computer = 'mac' | 'windows' | 'other'

// Which computer the browser runs on, for the microphone settings hint.
function computerOf(userAgent: string): Computer {
  if (/Macintosh|Mac OS X/.test(userAgent) && !/iPhone|iPad/.test(userAgent)) return 'mac'
  if (/Windows/.test(userAgent)) return 'windows'
  return 'other'
}

// Safari itself, not Chrome, Edge or Opera (which also say "Safari" in their user agent).
function isSafari(userAgent: string): boolean {
  return /Safari\//.test(userAgent) && !/Chrome\/|Chromium\/|Edg\/|OPR\//.test(userAgent)
}

const MIC_SETTINGS: Record<Computer, string> = {
  mac: ' and in System Settings → Privacy & Security → Microphone',
  windows: ' and in Windows Settings → Privacy & security → Microphone',
  other: '',
}

// What to tell the viewer when voice input fails, with settings advice for their system.
export function voiceErrorMessage(error: VoiceError, userAgent: string): string {
  const computer = computerOf(userAgent)
  switch (error) {
    case 'blocked':
      return `Microphone access is blocked. Allow it for this site in the browser's address bar${MIC_SETTINGS[computer]}, or type instead.`
    case 'no-mic':
      return 'No microphone found. Connect one or check it is switched on, or type instead.'
    case 'service':
      return computer === 'mac' && isSafari(userAgent)
        ? 'Voice input is off on this Mac. Turn on Dictation in System Settings → Keyboard, then try again, or type instead.'
        : "This browser's voice input isn't available. Try Chrome, Edge or Safari, or type instead."
    case 'no-speech':
      return "Didn't catch that. Press the microphone and try again."
    case 'network':
      return "Voice input couldn't reach the browser's speech service. Check the internet connection; if you're online, this browser may not offer voice input, so try Chrome, Edge or Safari."
    default:
      return "Voice input didn't work this time. Try again or type instead."
  }
}

export interface VoiceLike {
  name: string
  lang: string
  default: boolean
}

// macOS ships joke voices (bells, whispering, singing) that some browsers pick for plain "en".
const NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Junior|Ralph|Fred|Kathy|Deranged|Hysterical|Pipe Organ)\b/

// An English voice for read-aloud: the computer's own default if it is English, else one matching the
// browser's language (en-IN, en-GB...), else Indian, British or American English. Null while the
// browser is still loading its voices; the browser then chooses.
export function pickVoice<V extends VoiceLike>(voices: readonly V[], language: string): V | null {
  const english = voices.filter((v) => /^en([-_]|$)/i.test(v.lang) && !NOVELTY.test(v.name))
  if (english.length === 0) return null
  const norm = (s: string) => s.replace('_', '-').toLowerCase()
  const want = norm(language)
  return (
    english.find((v) => v.default) ??
    english.find((v) => norm(v.lang) === want) ??
    ['en-in', 'en-gb', 'en-us'].map((l) => english.find((v) => norm(v.lang) === l)).find(Boolean) ??
    english[0]
  )
}
