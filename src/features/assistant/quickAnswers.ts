// Quick answers for the public copy's Ask page. The public copy has no server, so Javed can't run
// there; instead a question is matched to a topic, a time and a place by fixed rules, and the
// answer is written from Open-Meteo's forecast and the models' exported forecasts. Nothing here
// guesses: when the data doesn't cover a question, the answer says so.
import type { ModelMetrics, PredictionsResult } from '../../lib/api/weatherai'
import { compass, dayName, utcToLocal, uvCategory, aqiCategory } from '../../lib/format'
import type { Format } from '../../lib/units'
import { describeWeather } from '../../lib/weatherCodes'
import type { AirQuality, DayDetail, Forecast, Place, WeekForecast, WeekHour } from '../../types/weather'

export type Topic = 'rain' | 'temperature' | 'wind' | 'humidity' | 'uv' | 'sun' | 'air' | 'warnings' | 'model' | 'accuracy' | 'general'

// When a question asks about: right now, tonight, one or more days, or the week ahead.
export type When =
  | { kind: 'now' }
  | { kind: 'tonight' }
  | { kind: 'day'; offset: number }
  | { kind: 'weekday'; day: number }
  | { kind: 'weekend' }
  | { kind: 'week' }

export interface ParsedQuestion {
  topic: Topic | null
  when: When | null
  // A place named in the question ("in Jaipur"), as typed; null means the place on screen.
  place: string | null
}

export interface AnswerData {
  place: Place
  forecast?: Forecast
  week?: WeekForecast
  air?: AirQuality
  predictions?: PredictionsResult
  models?: ModelMetrics[]
}

export interface Answer {
  text: string
  sources: string[]
}

// Topics in the order they are checked: the first that matches wins.
const TOPIC_RULES: [RegExp, Topic][] = [
  [/\b(warnings?|alerts?|advisor(y|ies)|red alert|orange alert)\b/, 'warnings'],
  [/\b(accura\w*|reliab\w*|how good|how well|how often .* right|errors?|trust)\b/, 'accuracy'],
  [/\b(wetcast'?s?( own)? models?|own models?|lstm|gru|cnn|transformer|lightgbm|ridge|ensemble|models? (expects?|predicts?|says?|forecasts?))\b/, 'model'],
  [/\b(air quality|aqi|pollution|polluted|smog|pm2\.?5|pm10|haze)\b/, 'air'],
  [/\b(uv|sunscreen|sunburn|sun cream)\b/, 'uv'],
  [/\b(sunrise|sunset|sun rise|sun set|sun come up|sun go down|daylight|get dark)\b/, 'sun'],
  [/\b(rain\w*|umbrella|showers?|drizzl\w*|wet|precipitation|monsoon|downpour|thunder\w*|storms?|stormy)\b/, 'rain'],
  [/\b(humid\w*|muggy|sticky|dew)\b/, 'humidity'],
  [/\b(wind\w*|breez\w*|gusts?|gusty)\b/, 'wind'],
  [/\b(temperatures?|temp|hot|cold|warm\w*|cool\w*|degrees?|heat|freez\w*|chilly|jacket|sweater)\b/, 'temperature'],
  [/\b(weather|forecast|outside|like|conditions?|sunny|cloudy|clear|fog\w*|snow\w*)\b/, 'general'],
]

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

// Words that end a place name in "in Delhi tomorrow", "for Pune over the next 24 hours".
const PLACE_STOP = new Set([
  'today', 'tomorrow', 'tonight', 'now', 'right', 'this', 'next', 'over', 'on', 'during', 'later', 'please',
  'and', 'with', 'at', 'in', 'for', 'near', 'around', 'by', 'between', 'from', 'until', 'till', 'after', 'before',
  'will', 'is', 'be', 'does', 'do', 'going', 'tomorrows', 'todays', 'tonights', 'weather', 'forecast', ...WEEKDAYS,
])

// Words that, on their own, are a time or a filler rather than a place ("in the evening").
const NOT_A_PLACE = new Set([
  'the', 'a', 'morning', 'afternoon', 'evening', 'night', 'noon', 'midnight', 'weekend', 'week', 'day', 'days',
  'hour', 'hours', 'moment', 'future', 'past', 'pm', 'am', 'general', 'total', 'india', 'there', 'here', 'my', 'area',
  'city', 'place', 'town', 'it', 'all', 'any', 'case', 'detail', 'short',
])

// Greetings and replies that aren't place names.
const SMALL_TALK = /^(hi|hello|hey|hiya|thanks?|thank you|ok|okay|yes|no|help|who are you|what can you do|test)\b/

// Lower-case, plain-apostrophe text with only letters, digits and a few joiners.
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9'. -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Capitalises each word: "new delhi" -> "New Delhi".
function titleCase(words: string): string {
  return words.replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

// The time a question asks about, or null when it names none.
export function parseWhen(text: string): When | null {
  if (/\b(right now|now|currently|at the moment|at present|outside right now)\b/.test(text)) return { kind: 'now' }
  if (/\b(tonight|this evening|overnight)\b/.test(text)) return { kind: 'tonight' }
  if (/\bday after tomorrow\b/.test(text)) return { kind: 'day', offset: 2 }
  if (/\btomorrow'?s?\b/.test(text)) return { kind: 'day', offset: 1 }
  if (/\b(this |the )?weekend\b/.test(text)) return { kind: 'weekend' }
  const weekday = WEEKDAYS.findIndex((d) => new RegExp(`\\b${d}\\b`).test(text))
  if (weekday >= 0) return { kind: 'weekday', day: weekday }
  if (/\b(this week|next week|week ahead|the week|next (few|seven|7) days|coming days|7 days?|seven days?|week)\b/.test(text)) return { kind: 'week' }
  if (/\b(today'?s?|this (morning|afternoon))\b/.test(text)) return { kind: 'day', offset: 0 }
  return null
}

// The place a question names after "in", "for", "at" or "near", or null.
export function parsePlace(text: string): string | null {
  const words = text.replace(/[.?!]+$/, '').split(' ')
  // The last "in X" wins, so "rain in the afternoon in Pune" finds Pune.
  for (let i = words.length - 2; i >= 0; i--) {
    if (!['in', 'for', 'at', 'near', 'around'].includes(words[i])) continue
    const name: string[] = []
    for (const w of words.slice(i + 1)) {
      if (PLACE_STOP.has(w)) break
      name.push(w.replace(/\.$/, ''))
    }
    while (name.length && (name[0] === 'the' || name[0] === 'a')) name.shift()
    if (!name.length || name.every((w) => NOT_A_PLACE.has(w) || /\d/.test(w))) continue
    return titleCase(name.join(' '))
  }
  return null
}

// What a typed question asks: a topic, a time and maybe a place.
export function parseQuestion(question: string): ParsedQuestion {
  const text = normalise(question)
  if (!text) return { topic: null, when: null, place: null }
  const topic = TOPIC_RULES.find(([re]) => re.test(text))?.[1] ?? null
  const when = parseWhen(text)
  let place = parsePlace(text)
  // A bare place name ("Lisbon", "Jaipur weather") asks for its weather.
  if (!place && !when && (topic === null || topic === 'general') && !SMALL_TALK.test(text)) {
    const rest = text.split(' ').filter((w) => !/^(weather|forecast|in|the|what'?s|whats|how'?s|is|it|like|for|please|show|me)$/.test(w))
    if (rest.length > 0 && rest.length <= 3 && rest.every((w) => /^[a-z][a-z'.-]*$/.test(w))) place = titleCase(rest.join(' '))
  }
  return { topic: topic ?? (place || when ? 'general' : null), when, place }
}

// True when a typed place is the one already on screen, so it needs no search.
export function isSamePlace(typed: string, place: Place): boolean {
  const t = normalise(typed).replace(/[.']/g, '')
  const names = [place.name, `${place.name} ${place.country ?? ''}`, `${place.name} ${place.admin1 ?? ''}`, `${place.name} ${place.admin1 ?? ''} ${place.country ?? ''}`]
  return names.some((n) => normalise(n).replace(/[.']/g, '') === t)
}

// Names a search can try for a typed place, longest first: "London United Kingdom", "London United", "London".
export function placeSearchNames(typed: string): string[] {
  const words = typed.split(' ').filter(Boolean)
  return words.map((_, i) => words.slice(0, words.length - i).join(' '))
}

// Letters only, without accents: "Léh" -> "leh".
function plain(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

// The best of a place search's results for a typed name. The search ranks big places first, so
// "Leh" would give Le Havre; an exact name wins, then one in the same country as the place on
// screen or in India, where the models are.
export function choosePlace(results: Place[], typed: string, current: Place): Place | undefined {
  const want = plain(typed)
  const exact = results.filter((r) => plain(r.name) === want)
  const local = (r: Place) => r.countryCode === current.countryCode || r.countryCode === 'IN'
  return exact.find(local) ?? exact[0] ?? results.find((r) => plain(r.name).startsWith(want)) ?? results[0]
}

// Which data an answer to this question needs, so nothing else is fetched.
export function needs(topic: Topic): { weather: boolean; air: boolean; predictions: boolean; models: boolean } {
  return {
    weather: !['warnings', 'accuracy', 'model'].includes(topic),
    air: topic === 'air',
    predictions: topic === 'model',
    models: topic === 'accuracy',
  }
}

// "21" for a whole-ish number, "0.4" below one.
function amount(mm: number): string {
  if (mm === 0) return '0'
  return mm < 1 ? mm.toFixed(1) : String(Math.round(mm))
}

// A day of the week forecast with its label ("today", "tomorrow", "on Friday").
interface DayPick {
  day: DayDetail
  index: number
  label: string
}

// "today", "tomorrow" or "on Friday" for the day at this index.
function dayLabel(day: DayDetail, index: number): string {
  if (index === 0) return 'today'
  if (index === 1) return 'tomorrow'
  return `on ${dayName(day.date, index, 'long')}`
}

// The days a time refers to, from the seven-day forecast.
export function pickDays(when: When | null, week: WeekForecast): DayPick[] {
  const all = week.daily.map((day, index) => ({ day, index, label: dayLabel(day, index) }))
  const weekdayOf = (p: DayPick) => new Date(`${p.day.date}T12:00:00`).getDay()
  if (!when || when.kind === 'now' || when.kind === 'tonight') return all.slice(0, 1)
  if (when.kind === 'day') return all.slice(when.offset, when.offset + 1)
  if (when.kind === 'weekday') return all.filter((p) => weekdayOf(p) === when.day).slice(0, 1)
  if (when.kind === 'weekend') {
    const first = all.findIndex((p) => weekdayOf(p) === 6 || weekdayOf(p) === 0)
    if (first < 0) return []
    return all.slice(first, first + (weekdayOf(all[first]) === 6 ? 2 : 1))
  }
  return all
}

// The hours of one day that haven't happened yet (all of them for later days).
function hoursOf(week: WeekForecast, date: string): WeekHour[] {
  return week.hourly.filter((h) => h.time.startsWith(date) && !h.isPast)
}

// Tonight's hours: 18:00 today to 06:00 tomorrow, from now on.
function tonightHours(week: WeekForecast): WeekHour[] {
  const today = week.daily[0]?.date
  const tomorrow = week.daily[1]?.date
  if (!today) return []
  return week.hourly.filter(
    (h) => !h.isPast && ((h.time.startsWith(today) && h.time.slice(11, 13) >= '18') || (tomorrow !== undefined && h.time.startsWith(tomorrow) && h.time.slice(11, 13) < '06')),
  )
}

// Largest of the values that are there, or null.
function maxOf(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null)
  return v.length ? Math.max(...v) : null
}

// Smallest of the values that are there, or null.
function minOf(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null)
  return v.length ? Math.min(...v) : null
}

// Sum of the values that are there, or null.
function sumOf(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null)
  return v.length ? v.reduce((a, b) => a + b, 0) : null
}

// "between 14:00 and 17:00" for the hours where rain is likely.
function rainWindow(hours: WeekHour[], fmt: Format): string {
  const wet = hours.filter((h) => (h.precipitationProbability ?? 0) >= 50)
  if (!wet.length) return ''
  const first = fmt.time(wet[0].time)
  const last = fmt.time(wet[wet.length - 1].time)
  return first === last ? `, most likely around ${first}` : `, most likely between ${first} and ${last}`
}

// One day's rain in a sentence.
function rainForDay(pick: DayPick, hours: WeekHour[], where: string): string {
  const chance = pick.index === 0 && hours.length ? maxOf(hours.map((h) => h.precipitationProbability)) : pick.day.precipitationProbabilityMax
  const total = pick.index === 0 && hours.length ? sumOf(hours.map((h) => h.precipitation)) : pick.day.precipitationSum
  const when = pick.index === 0 ? 'for the rest of today' : pick.label
  if (chance === null) return `Open-Meteo has no chance of rain for ${where} ${when}.`
  const mm = total !== null && total >= 0.1 ? `, about ${amount(total)} mm in all` : ''
  if (chance < 20) return `Rain is unlikely in ${where} ${when}: the highest chance in any hour is ${chance}%.`
  if (chance < 50) return `There's a small chance of rain in ${where} ${when}: up to ${chance}% in any hour${mm}.`
  return `Rain is likely in ${where} ${when}: up to ${chance}% chance in an hour${mm}`
}

// The rain answer.
function answerRain(q: ParsedQuestion, d: Required<Pick<AnswerData, 'forecast' | 'week'>>, where: string, fmt: Format): string {
  const { forecast, week } = d
  if (q.when?.kind === 'now') {
    const now = forecast.current.precipitation > 0
      ? `It's raining in ${where} now: ${amount(forecast.current.precipitation)} mm in the last hour.`
      : `It isn't raining in ${where} right now.`
    const next = week.hourly.filter((h) => !h.isPast).slice(0, 12)
    const wet = next.find((h) => (h.precipitationProbability ?? 0) >= 50)
    const top = maxOf(next.map((h) => h.precipitationProbability))
    const later = wet
      ? ` Rain becomes likely around ${fmt.time(wet.time)} (${wet.precipitationProbability}% chance).`
      : top !== null
        ? ` Rain is unlikely in the next 12 hours: the highest chance in any hour is ${top}%.`
        : ''
    return now + later
  }
  if (q.when?.kind === 'tonight') {
    const hours = tonightHours(week)
    const top = maxOf(hours.map((h) => h.precipitationProbability))
    if (top === null) return `Open-Meteo has no chance of rain for ${where} tonight.`
    const total = sumOf(hours.map((h) => h.precipitation)) ?? 0
    if (top < 20) return `Rain is unlikely in ${where} tonight: the highest chance in any hour is ${top}%.`
    const mm = total >= 0.1 ? `, about ${amount(total)} mm in all` : ''
    return top < 50
      ? `There's a small chance of rain in ${where} tonight: up to ${top}% in any hour${mm}.`
      : `Rain is likely in ${where} tonight: up to ${top}% chance in an hour${mm}${rainWindow(hours, fmt)}.`
  }
  const days = pickDays(q.when, week)
  if (!days.length) return `That day is beyond the 7 days Open-Meteo forecasts for ${where}.`
  if (days.length === 1) {
    const hours = hoursOf(week, days[0].day.date)
    const line = rainForDay(days[0], hours, where)
    return line.endsWith('.') ? line : `${line}${rainWindow(hours, fmt)}.`
  }
  const lines = days.map((p) => {
    const name = dayName(p.day.date, p.index, 'long')
    const chance = p.day.precipitationProbabilityMax
    const mm = p.day.precipitationSum
    return `${name}: ${chance === null ? 'no data' : `${chance}%`}${mm !== null && mm >= 0.1 ? `, ${amount(mm)} mm` : ''}`
  })
  const wet = days.filter((p) => (p.day.precipitationProbabilityMax ?? 0) >= 50)
  const head = wet.length
    ? `Rain is likely in ${where} on ${wet.length === 1 ? 'one day' : `${wet.length} days`}: ${wet.map((p) => dayName(p.day.date, p.index, 'long')).join(', ')}.`
    : `No day looks rainy in ${where}: no day has a 50% chance of rain in any hour.`
  return `${head}\nHighest hourly chance of rain each day:\n${lines.join('\n')}`
}

// The temperature answer.
function answerTemperature(q: ParsedQuestion, d: Required<Pick<AnswerData, 'forecast' | 'week'>>, where: string, fmt: Format): string {
  const { forecast, week } = d
  const today = week.daily[0]
  if (q.when?.kind === 'now') {
    const c = forecast.current
    const range = today?.tempMax != null && today.tempMin != null ? ` Today ranges from ${fmt.t(today.tempMin)} to ${fmt.t(today.tempMax)}.` : ''
    return `It's ${fmt.t(c.temperature)} in ${where} now, feeling like ${fmt.t(c.apparentTemperature)}.${range}`
  }
  if (q.when?.kind === 'tonight') {
    const low = minOf(tonightHours(week).map((h) => h.temperature))
    return low === null ? `Open-Meteo has no temperatures for ${where} tonight.` : `Tonight in ${where} it drops to about ${fmt.t(low)}.`
  }
  const days = pickDays(q.when, week)
  if (!days.length) return `That day is beyond the 7 days Open-Meteo forecasts for ${where}.`
  if (days.length === 1) {
    const { day, label } = days[0]
    if (day.tempMax === null || day.tempMin === null) return `Open-Meteo has no temperatures for ${where} ${label}.`
    const sky = day.weatherCode !== null ? ` ${describeWeather(day.weatherCode)}.` : ''
    return `${label === 'today' ? 'Today' : titleCase(label)} in ${where}: a high of ${fmt.t(day.tempMax)} and a low of ${fmt.t(day.tempMin)}.${sky}`
  }
  const lines = days.map((p) => `${dayName(p.day.date, p.index, 'long')}: ${p.day.tempMax === null ? '?' : fmt.deg(p.day.tempMax)} / ${p.day.tempMin === null ? '?' : fmt.deg(p.day.tempMin)}`)
  const highs = days.map((p) => p.day.tempMax)
  return `Highs and lows in ${where} (${fmt.tempUnit}), warmest ${fmt.t(maxOf(highs) ?? 0)}:\n${lines.join('\n')}`
}

// The wind answer.
function answerWind(q: ParsedQuestion, d: Required<Pick<AnswerData, 'forecast' | 'week'>>, where: string, fmt: Format): string {
  const { forecast, week } = d
  if (q.when?.kind === 'now') {
    const c = forecast.current
    const gusts = c.windGusts !== null ? `, with gusts up to ${fmt.s(c.windGusts)}` : ''
    return `The wind in ${where} is ${fmt.s(c.windSpeed)} from the ${compass(c.windDirection)}${gusts}.`
  }
  if (q.when?.kind === 'tonight') {
    const top = maxOf(tonightHours(week).map((h) => h.windSpeed))
    return top === null ? `Open-Meteo has no wind for ${where} tonight.` : `Tonight the wind in ${where} reaches about ${fmt.s(top)}.`
  }
  const days = pickDays(q.when, week)
  if (!days.length) return `That day is beyond the 7 days Open-Meteo forecasts for ${where}.`
  const line = (p: DayPick) => {
    const parts = [p.day.windSpeedMax !== null ? `up to ${fmt.s(p.day.windSpeedMax)}` : 'no wind data']
    if (p.day.windGustsMax !== null) parts.push(`gusts to ${fmt.s(p.day.windGustsMax)}`)
    if (p.day.windDirection !== null) parts.push(`mostly from the ${compass(p.day.windDirection)}`)
    return parts.join(', ')
  }
  if (days.length === 1) return `Wind in ${where} ${days[0].label}: ${line(days[0])}.`
  return `Wind in ${where}:\n${days.map((p) => `${dayName(p.day.date, p.index, 'long')}: ${line(p)}`).join('\n')}`
}

// The humidity answer. Open-Meteo's hourly humidity here covers about the next day.
function answerHumidity(q: ParsedQuestion, d: Required<Pick<AnswerData, 'forecast' | 'week'>>, where: string): string {
  const { forecast, week } = d
  if (!q.when || q.when.kind === 'now') return `Humidity in ${where} is ${Math.round(forecast.current.humidity)}% now.`
  const upcoming = forecast.hourly.filter((h) => !h.isPast)
  let hours = upcoming
  let label = 'over the next day'
  if (q.when.kind === 'tonight') {
    const night = new Set(tonightHours(week).map((h) => h.time))
    hours = upcoming.filter((h) => night.has(h.time))
    label = 'tonight'
  } else {
    const days = pickDays(q.when, week)
    if (days.length === 1) {
      hours = upcoming.filter((h) => h.time.startsWith(days[0].day.date))
      label = days[0].label
    }
  }
  const low = minOf(hours.map((h) => h.humidity))
  const high = maxOf(hours.map((h) => h.humidity))
  if (low === null || high === null) return `Humidity is only forecast here for about the next 24 hours. Right now it's ${Math.round(forecast.current.humidity)}% in ${where}.`
  return `Humidity in ${where} ${label}: between ${Math.round(low)}% and ${Math.round(high)}%.`
}

// The UV answer.
function answerUv(q: ParsedQuestion, d: Required<Pick<AnswerData, 'forecast' | 'week'>>, where: string): string {
  if (q.when?.kind === 'now' && d.forecast.current.uvIndex !== null) {
    const uv = d.forecast.current.uvIndex
    return `The UV index in ${where} is ${Math.round(uv)} now (${uvCategory(uv).toLowerCase()}).`
  }
  const days = pickDays(q.when, d.week)
  if (!days.length) return `That day is beyond the 7 days Open-Meteo forecasts for ${where}.`
  const line = (p: DayPick) => (p.day.uvIndexMax === null ? 'no data' : `${Math.round(p.day.uvIndexMax)} (${uvCategory(p.day.uvIndexMax).toLowerCase()})`)
  if (days.length === 1) return `The highest UV index in ${where} ${days[0].label} is ${line(days[0])}.`
  return `Highest UV index each day in ${where}:\n${days.map((p) => `${dayName(p.day.date, p.index, 'long')}: ${line(p)}`).join('\n')}`
}

// The sunrise and sunset answer.
function answerSun(q: ParsedQuestion, d: Required<Pick<AnswerData, 'forecast' | 'week'>>, where: string, fmt: Format): string {
  const days = pickDays(q.when?.kind === 'week' ? { kind: 'day', offset: 0 } : q.when, d.week)
  if (!days.length) return `That day is beyond the 7 days Open-Meteo forecasts for ${where}.`
  const { day, label } = days[0]
  if (!day.sunrise || !day.sunset) return `Open-Meteo has no sunrise or sunset for ${where} ${label}.`
  return `In ${where} ${label}, the sun rises at ${fmt.time(day.sunrise)} and sets at ${fmt.time(day.sunset)} (local time).`
}

// The air quality answer.
function answerAir(air: AirQuality | undefined, where: string): string {
  if (!air || air.europeanAqi === null) return `There's no air quality reading for ${where} right now.`
  const pm = air.pm2_5 !== null ? ` Fine particles (PM2.5): ${Math.round(air.pm2_5)} µg/m³.` : ''
  return `Air quality in ${where} is ${aqiCategory(air.europeanAqi).toLowerCase()} right now: ${Math.round(air.europeanAqi)} on the European index.${pm}`
}

// The general "what's the weather" answer.
function answerGeneral(q: ParsedQuestion, d: Required<Pick<AnswerData, 'forecast' | 'week'>>, where: string, fmt: Format): string {
  const { forecast, week } = d
  if (!q.when || q.when.kind === 'now') {
    const c = forecast.current
    const now = `Now in ${where}: ${describeWeather(c.weatherCode, c.isDay).toLowerCase()}, ${fmt.t(c.temperature)} (feels like ${fmt.t(c.apparentTemperature)}), humidity ${Math.round(c.humidity)}%, wind ${fmt.s(c.windSpeed)}.`
    if (q.when) return now
    const today = pickDays({ kind: 'day', offset: 0 }, week)[0]
    return today ? `${now}\n${rainForDay(today, hoursOf(week, today.day.date), where).replace(/:.*$/, '.')}` : now
  }
  if (q.when.kind === 'tonight') {
    const hours = tonightHours(week)
    const low = minOf(hours.map((h) => h.temperature))
    const rain = maxOf(hours.map((h) => h.precipitationProbability))
    if (low === null) return `Open-Meteo has no forecast for ${where} tonight.`
    return `Tonight in ${where}: down to ${fmt.t(low)}, with ${rain === null ? 'no rain data' : `up to a ${rain}% chance of rain in any hour`}.`
  }
  const days = pickDays(q.when, week)
  if (!days.length) return `That day is beyond the 7 days Open-Meteo forecasts for ${where}.`
  const line = (p: DayPick) => {
    const parts: string[] = []
    if (p.day.weatherCode !== null) parts.push(describeWeather(p.day.weatherCode).toLowerCase())
    if (p.day.tempMax !== null && p.day.tempMin !== null) parts.push(`${fmt.deg(p.day.tempMax)} / ${fmt.deg(p.day.tempMin)}`)
    if (p.day.precipitationProbabilityMax !== null) parts.push(`rain chance up to ${p.day.precipitationProbabilityMax}%`)
    if (p.day.windSpeedMax !== null) parts.push(`wind up to ${fmt.s(p.day.windSpeedMax)}`)
    return parts.join(', ')
  }
  if (days.length === 1) return `${titleCase(days[0].label)} in ${where}: ${line(days[0])}.`
  return `The days ahead in ${where} (high / low):\n${days.map((p) => `${dayName(p.day.date, p.index, 'long')}: ${line(p)}`).join('\n')}`
}

// Great-circle distance in km.
function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180
  const dLat = Math.sin(((lat2 - lat1) * rad) / 2)
  const dLon = Math.sin(((lon2 - lon1) * rad) / 2)
  const a = dLat * dLat + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * dLon * dLon
  return 2 * 6371 * Math.asin(Math.sqrt(a))
}

// What Wetcast's own models expect over their 24 hours.
function answerModel(d: AnswerData, where: string, fmt: Format): string {
  const result = d.predictions
  if (!result) return "Wetcast's own model forecasts couldn't be loaded. Try again in a moment."
  if (result.kind === 'unsupported') {
    const nearest = [...result.supported].sort(
      (a, b) => distanceKm(d.place.latitude, d.place.longitude, a.latitude, a.longitude) - distanceKm(d.place.latitude, d.place.longitude, b.latitude, b.longitude),
    )[0]
    const km = nearest ? Math.round(distanceKm(d.place.latitude, d.place.longitude, nearest.latitude, nearest.longitude)) : null
    const hint = nearest && km !== null && km <= 300 ? ` The nearest is ${nearest.name}, ${km} km away: ask about it by name.` : ' The Models page lists them.'
    return `Wetcast's own models forecast for ${result.supported.length} cities in India, and ${where} isn't one of them.${hint}`
  }
  const data = result.data
  const model = data.models.find((m) => m.model === 'ensemble') ?? data.models[0]
  if (!model || !model.points.length) return `The latest update has no model forecast for ${data.city.name}.`
  const offset = d.week?.utcOffsetSeconds ?? 0
  const local = (iso: string) => fmt.time(utcToLocal(iso, offset))
  const pts = model.points
  const coldest = pts.reduce((a, b) => (b.temperature < a.temperature ? b : a))
  const warmest = pts.reduce((a, b) => (b.temperature > a.temperature ? b : a))
  const hum = pts.map((p) => p.humidity)
  const rain = pts.reduce((s, p) => s + p.precipitation, 0)
  const chance = maxOf(pts.map((p) => (p.rain_chance === null || p.rain_chance === undefined ? null : p.rain_chance)))
  const chanceText = chance !== null ? ` (highest hourly chance of rain ${Math.round(chance * 100)}%)` : ''
  const rainLine = rain < 0.1 ? `no rain${chanceText}` : `about ${amount(rain)} mm of rain${chanceText}`
  const name = data.city.name === where.split(',')[0] ? data.city.name : `${data.city.name} (the models' city nearest ${where})`
  return `Wetcast's ${model.display_name} model for ${name}, next ${pts.length} hours: ${fmt.t(coldest.temperature)} at its coldest (around ${local(coldest.time)}) and ${fmt.t(warmest.temperature)} at its warmest (around ${local(warmest.time)}), humidity ${Math.round(Math.min(...hum))}% to ${Math.round(Math.max(...hum))}%, and ${rainLine}. Issued at ${local(data.issued_at)}, updated every 3 hours.`
}

// How accurate the models were on the test period.
function answerAccuracy(models: ModelMetrics[] | undefined, fmt: Format): string {
  const m = models?.find((x) => x.model === 'ensemble') ?? models?.[0]
  if (!m) return "Wetcast's model test scores couldn't be loaded. Try again in a moment."
  const t = (x: number) => `${fmt.tempDelta(x).toFixed(1)}${fmt.tempUnit.replace('°', ' °')}`
  const [from, to] = m.data.splits.test
  const period = `${from.slice(0, 7)} to ${to.slice(0, 7)}`
  const seen = `${t(m.test.temperature.mae)} for temperature, ${m.test.humidity.mae.toFixed(1)}% for humidity and ${m.test.precipitation.mae.toFixed(2)} mm for hourly rain`
  const base = `${t(m.persistence_baseline.temperature.mae)}, ${m.persistence_baseline.humidity.mae.toFixed(1)}% and ${m.persistence_baseline.precipitation.mae.toFixed(2)} mm`
  const unseen = m.test_unseen ? ` At the cities it never trained on, it was off by ${t(m.test_unseen.temperature.mae)} for temperature.` : ''
  return `On data it never saw (${period}), Wetcast's ${m.display_name} model was off by an average of ${seen}, over the next 24 hours. Simply repeating yesterday's weather was off by ${base}.${unseen} The Models page has every model's scores.`
}

// Why the public copy can't check official warnings, and where to look instead.
function answerWarnings(place: Place, where: string): string {
  const india = place.countryCode === 'IN'
  return `Official warnings come from Wetcast's server, which this public copy doesn't have, so they can't be checked for ${where} here. ${
    india ? 'For India, see the India Meteorological Department at mausam.imd.gov.in.' : 'Your national weather service has the current warnings.'
  }`
}

// What to type, for a question the rules didn't understand.
export const HELP_TEXT =
  "I didn't catch that. I answer simple weather questions by fixed rules: rain, temperature, wind, humidity, UV, sunrise and sunset, air quality, and Wetcast's own models, for now, tonight, today, tomorrow, a weekday or the week ahead. Try \"Will it rain in Jaipur tomorrow?\" or \"How hot is it in Chennai right now?\""

// The answer to a parsed question from the data fetched for it.
export function composeAnswer(q: ParsedQuestion, d: AnswerData, where: string, fmt: Format): Answer {
  const topic = q.topic ?? 'general'
  if (topic === 'warnings') return { text: answerWarnings(d.place, where), sources: [] }
  if (topic === 'model') return { text: answerModel(d, where, fmt), sources: ["Wetcast's model forecasts"] }
  if (topic === 'accuracy') return { text: answerAccuracy(d.models, fmt), sources: ["Wetcast's model test scores"] }
  if (topic === 'air') return { text: answerAir(d.air, where), sources: ['Open-Meteo air quality'] }
  if (!d.forecast || !d.week) return { text: `The forecast for ${where} couldn't be loaded. Try again in a moment.`, sources: [] }
  const w = { forecast: d.forecast, week: d.week }
  const text =
    topic === 'rain' ? answerRain(q, w, where, fmt)
    : topic === 'temperature' ? answerTemperature(q, w, where, fmt)
    : topic === 'wind' ? answerWind(q, w, where, fmt)
    : topic === 'humidity' ? answerHumidity(q, w, where)
    : topic === 'uv' ? answerUv(q, w, where)
    : topic === 'sun' ? answerSun(q, w, where, fmt)
    : answerGeneral(q, w, where, fmt)
  return { text, sources: ['Open-Meteo forecast'] }
}
