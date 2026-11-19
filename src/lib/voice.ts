import type { PageId } from '../app/pages'

/**
 * Turns a spoken phrase into a place name and/or a page, using fixed rules
 * (no AI): "weather in New Delhi", "will it rain in Mumbai this week",
 * "Lisbon", "open the models page".
 */
export interface VoiceCommand {
  place: string | null
  page: PageId | null
}

const PAGE_RULES: [RegExp, PageId][] = [
  [/\b(maps?|radar)\b/, 'map'],
  [/\b(forecast|tomorrow|this week|next week|next few days|7 day|seven day|week)\b/, 'forecast'],
  [/\b(compare|comparison|saved|locations?|places)\b/, 'locations'],
  [/\b(analytics|history|historical|trends?|past)\b/, 'analytics'],
  [/\b(models?|accuracy|lstm|gru)\b/, 'models'],
  [/\babout\b/, 'about'],
  [/\b(dashboard|right now|currently|current)\b/, 'dashboard'],
]

// Words that frame a question rather than name a place.
const FILLER = new Set(
  (
    "what what's whats is it the a an weather forecast show me tell how hows how's will would be like rain raining rainy " +
    'temperature temp hot cold humid humidity wind windy going to open page go please today tomorrow now right this ' +
    'next week few days day current currently there here check find search for in at of get give compare saved locations ' +
    'location places analytics history historical trends trend past models model accuracy about dashboard seven 7 sunny ' +
    'map maps radar cloudy snow outside my your our and with than to do does can you i want see look up hey ok okay'
  ).split(/\s+/),
)

// Trailing time words after the place: "in Delhi tomorrow".
const TRAILING_TIME = /\s+(?:today|tomorrow|tonight|now|right now|this week|next week|this weekend|next few days|please)$/

function titleCase(words: string): string {
  return words
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export function parseVoiceCommand(transcript: string): VoiceCommand {
  const text = transcript
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9' -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return { place: null, page: null }

  const page = PAGE_RULES.find(([re]) => re.test(text))?.[1] ?? null

  // "... in/for/at <place> [time words]" is the clearest signal.
  let place: string | null = null
  const match = text.match(/\b(?:in|for|at|near)\s+([a-z][a-z' -]*)$/)
  if (match) {
    let candidate = match[1]
    while (TRAILING_TIME.test(candidate)) candidate = candidate.replace(TRAILING_TIME, '')
    const words = candidate.split(' ').filter((w) => w && !['the', 'a'].includes(w))
    if (words.length > 0 && !words.every((w) => FILLER.has(w))) place = titleCase(words.join(' '))
  }

  // Otherwise whatever is left after removing question words, e.g. "Lisbon" or "Jaipur weather".
  if (!place) {
    const rest = text.split(' ').filter((w) => !FILLER.has(w))
    if (rest.length > 0 && rest.length <= 4) place = titleCase(rest.join(' '))
  }

  return { place, page }
}
