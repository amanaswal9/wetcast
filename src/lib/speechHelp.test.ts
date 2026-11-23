import { describe, expect, it } from 'vitest'
import { pickVoice, toVoiceError, voiceErrorMessage } from './speechHelp'

const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const WIN_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

describe('voice search errors', () => {
  it('tells a missing microphone apart from a blocked one', () => {
    expect(toVoiceError('audio-capture')).toBe('no-mic')
    expect(toVoiceError('not-allowed')).toBe('blocked')
    expect(toVoiceError('service-not-allowed')).toBe('service')
    expect(toVoiceError('something-new')).toBe('other')
  })

  it('names the right settings for the computer', () => {
    expect(voiceErrorMessage('blocked', MAC_CHROME)).toContain('System Settings → Privacy & Security → Microphone')
    expect(voiceErrorMessage('blocked', WIN_EDGE)).toContain('Windows Settings → Privacy & security → Microphone')
    expect(voiceErrorMessage('blocked', LINUX)).not.toMatch(/Windows|System Settings/)
  })

  it('points Safari on a Mac to Dictation, other browsers to a supported one', () => {
    expect(voiceErrorMessage('service', MAC_SAFARI)).toContain('Dictation')
    expect(voiceErrorMessage('service', MAC_CHROME)).toContain('Chrome, Edge or Safari')
    expect(voiceErrorMessage('service', WIN_EDGE)).not.toContain('Dictation')
  })
})

describe('read-aloud voice', () => {
  const v = (name: string, lang: string, isDefault = false) => ({ name, lang, default: isDefault })

  it("uses the computer's default when it is English", () => {
    expect(pickVoice([v('Microsoft Hazel', 'en-GB'), v('Microsoft George', 'en-GB', true)], 'en-IN')?.name).toBe('Microsoft George')
  })

  it('skips macOS joke voices and prefers the browser language', () => {
    const mac = [v('Albert', 'en-US'), v('Bells', 'en-US'), v('Samantha', 'en-US'), v('Rishi', 'en-IN'), v('Amélie', 'fr-CA', true)]
    expect(pickVoice(mac, 'en-IN')?.name).toBe('Rishi')
    expect(pickVoice(mac, 'en-US')?.name).toBe('Samantha')
    expect(pickVoice(mac, 'fr-FR')?.name).toBe('Rishi') // Indian English first when the browser isn't in English
  })

  it('returns null while voices are still loading', () => {
    expect(pickVoice([], 'en-IN')).toBeNull()
  })
})
