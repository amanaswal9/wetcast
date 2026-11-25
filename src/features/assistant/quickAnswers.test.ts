import { describe, expect, it } from 'vitest'
import type { ModelMetrics, Predictions } from '../../lib/api/weatherai'
import { makeFormat } from '../../lib/units'
import type { DayDetail, Forecast, Place, WeekForecast, WeekHour } from '../../types/weather'
import { choosePlace, composeAnswer, HELP_TEXT, isSamePlace, parsePlace, parseQuestion, parseWhen, pickDays, placeSearchNames } from './quickAnswers'

const fmt = makeFormat({ temp: 'c', speed: 'kmh', clock: '24' })
const delhi: Place = { id: '1', name: 'Delhi', country: 'India', countryCode: 'IN', latitude: 28.65, longitude: 77.23 }

// Seven days from Thursday 26 November 2026; "now" is 10:00 on the first day.
const DATES = ['2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']

// One forecast day; rain chance and amount vary by day so answers differ.
function day(date: string, i: number): DayDetail {
  return {
    date,
    weatherCode: i === 1 ? 63 : 1,
    tempMax: 25 + i,
    tempMin: 10 + i,
    sunrise: `${date}T06:55`,
    sunset: `${date}T17:28`,
    daylightSeconds: 37_000,
    uvIndexMax: 4,
    precipitationProbabilityMax: i === 1 ? 80 : 5,
    precipitationSum: i === 1 ? 6.2 : 0,
    windSpeedMax: 12,
    windGustsMax: 25,
    windDirection: 315,
  }
}

// Hourly rows: tomorrow is wet from 14:00 to 16:00, everything else dry.
function hours(): WeekHour[] {
  return DATES.flatMap((date, d) =>
    Array.from({ length: 24 }, (_, h) => {
      const wet = d === 1 && h >= 14 && h <= 16
      return {
        time: `${date}T${String(h).padStart(2, '0')}:00`,
        temperature: 12 + h / 2,
        precipitationProbability: wet ? 80 : 5,
        precipitation: wet ? 2 : 0,
        windSpeed: 8,
        weatherCode: 1,
        isPast: d === 0 && h <= 10,
      }
    }),
  )
}

const week: WeekForecast = {
  timezone: 'Asia/Kolkata',
  utcOffsetSeconds: 19_800,
  currentTime: '2026-11-26T10:00',
  hourly: hours(),
  daily: DATES.map(day),
  fetchedAt: 0,
}

const forecast: Forecast = {
  timezone: 'Asia/Kolkata',
  current: {
    time: '2026-11-26T10:00',
    temperature: 21.4,
    apparentTemperature: 20.6,
    humidity: 55,
    precipitation: 0,
    weatherCode: 1,
    cloudCover: 20,
    isDay: true,
    windSpeed: 9,
    windDirection: 300,
    windGusts: 18,
    pressure: 1015,
    uvIndex: 3,
  },
  // 10:00 today to 10:00 tomorrow.
  hourly: Array.from({ length: 25 }, (_, h) => ({
    time: h < 14 ? `2026-11-26T${String(10 + h).padStart(2, '0')}:00` : `2026-11-27T${String(h - 14).padStart(2, '0')}:00`,
    temperature: 20,
    humidity: 40 + h,
    precipitationProbability: 5,
    precipitation: 0,
    windSpeed: 8,
    isPast: h === 0,
  })),
  daily: [],
  fetchedAt: 0,
}

// Answers a question about Delhi with the test data.
function ask(question: string, extra: Partial<Parameters<typeof composeAnswer>[1]> = {}) {
  return composeAnswer(parseQuestion(question), { place: delhi, forecast, week, ...extra }, 'Delhi', fmt).text
}

describe('parseQuestion', () => {
  it.each([
    ['Will it rain in Jaipur tomorrow?', 'rain', { kind: 'day', offset: 1 }, 'Jaipur'],
    ['Do I need an umbrella in New Delhi on Friday', 'rain', { kind: 'weekday', day: 5 }, 'New Delhi'],
    ['How hot is it in Chennai right now?', 'temperature', { kind: 'now' }, 'Chennai'],
    ["What's the weather like in Mumbai this weekend", 'general', { kind: 'weekend' }, 'Mumbai'],
    ['Is it windy?', 'wind', null, null],
    ['Will it rain in the afternoon in Pune?', 'rain', null, 'Pune'],
    ["What does Wetcast's own model expect in London, United Kingdom over the next 24 hours?", 'model', null, 'London United Kingdom'],
    ['Are there any official weather warnings for Jaipur?', 'warnings', null, 'Jaipur'],
    ['How accurate are Wetcast’s models?', 'accuracy', null, null],
    ['When is sunset tomorrow', 'sun', { kind: 'day', offset: 1 }, null],
    ['Lisbon', 'general', null, 'Lisbon'],
    ['Jaipur weather', 'general', null, 'Jaipur'],
    ['rain this week', 'rain', { kind: 'week' }, null],
    ['air quality in Delhi', 'air', null, 'Delhi'],
    ['how cold will it get tonight', 'temperature', { kind: 'tonight' }, null],
  ])('%s', (question, topic, when, place) => {
    expect(parseQuestion(question)).toEqual({ topic, when, place })
  })

  it('does not take greetings or empty text for a place', () => {
    expect(parseQuestion('hello')).toEqual({ topic: null, when: null, place: null })
    expect(parseQuestion('  ?! ')).toEqual({ topic: null, when: null, place: null })
  })

  it('reads times without a topic', () => {
    expect(parseWhen('day after tomorrow')).toEqual({ kind: 'day', offset: 2 })
    expect(parsePlace('rain in the evening')).toBeNull()
    expect(parsePlace('weather at 5 pm')).toBeNull()
  })
})

describe('places', () => {
  it('matches the place on screen in its short and long forms', () => {
    expect(isSamePlace('London United Kingdom', { ...delhi, name: 'London', country: 'United Kingdom' })).toBe(true)
    expect(isSamePlace('Delhi', delhi)).toBe(true)
    expect(isSamePlace('Jaipur', delhi)).toBe(false)
  })

  it('prefers an exact name, then one in the same country or India', () => {
    const p = (name: string, countryCode: string) => ({ id: name + countryCode, name, countryCode, latitude: 0, longitude: 0 })
    expect(choosePlace([p('Le Havre', 'FR'), p('Leh', 'IN'), p('Leh', 'AT')], 'Leh', delhi)?.countryCode).toBe('IN')
    expect(choosePlace([p('Genoa', 'IT'), p('Goa', 'PH')], 'Goa', delhi)?.name).toBe('Goa')
    expect(choosePlace([p('Lehi', 'US')], 'Leh', delhi)?.name).toBe('Lehi')
    expect(choosePlace([], 'Leh', delhi)).toBeUndefined()
  })

  it('tries shorter names when the full one finds nothing', () => {
    expect(placeSearchNames('London United Kingdom')).toEqual(['London United Kingdom', 'London United', 'London'])
  })
})

describe('pickDays', () => {
  it('finds tomorrow, a weekday and the weekend', () => {
    expect(pickDays({ kind: 'day', offset: 1 }, week).map((p) => p.day.date)).toEqual(['2026-11-27'])
    expect(pickDays({ kind: 'weekday', day: 1 }, week).map((p) => p.day.date)).toEqual(['2026-11-30'])
    expect(pickDays({ kind: 'weekend' }, week).map((p) => p.day.date)).toEqual(['2026-11-28', '2026-11-29'])
    expect(pickDays({ kind: 'week' }, week)).toHaveLength(7)
  })
})

describe('composeAnswer', () => {
  it('answers rain tomorrow with the chance, amount and hours', () => {
    expect(ask('Will it rain tomorrow?')).toBe('Rain is likely in Delhi tomorrow: up to 80% chance in an hour, about 6 mm in all, most likely between 14:00 and 16:00.')
  })

  it('answers a dry day plainly', () => {
    expect(ask('Will it rain on Saturday?')).toBe('Rain is unlikely in Delhi on Saturday: the highest chance in any hour is 5%.')
  })

  it('answers rain now and looks ahead 12 hours', () => {
    expect(ask('Is it raining right now?')).toBe("It isn't raining in Delhi right now. Rain is unlikely in the next 12 hours: the highest chance in any hour is 5%.")
  })

  it('lists the rainy days of the week', () => {
    const text = ask('Will it rain this week?')
    expect(text.startsWith('Rain is likely in Delhi on one day: Tomorrow.')).toBe(true)
    expect(text).toContain('Tomorrow: 80%, 6 mm')
  })

  it('gives temperatures now and for a day', () => {
    expect(ask('temperature now')).toBe("It's 21°C in Delhi now, feeling like 21°C. Today ranges from 10°C to 25°C.")
    expect(ask('how hot tomorrow')).toBe('Tomorrow in Delhi: a high of 26°C and a low of 11°C. Rain.')
  })

  it('follows the chosen units', () => {
    const us = makeFormat({ temp: 'f', speed: 'mph', clock: '12' })
    const text = composeAnswer(parseQuestion('sunset tomorrow'), { place: delhi, forecast, week }, 'Delhi', us).text
    expect(text).toBe('In Delhi tomorrow, the sun rises at 6:55 am and sets at 5:28 pm (local time).')
  })

  it('gives wind, humidity and UV', () => {
    expect(ask('how windy is it now')).toBe('The wind in Delhi is 9 km/h from the WNW, with gusts up to 18 km/h.')
    expect(ask('wind tomorrow')).toBe('Wind in Delhi tomorrow: up to 12 km/h, gusts to 25 km/h, mostly from the NW.')
    expect(ask('how humid is it')).toBe('Humidity in Delhi is 55% now.')
    expect(ask('UV index today')).toBe('The highest UV index in Delhi today is 4 (moderate).')
  })

  it('says plainly that warnings need the server', () => {
    expect(ask('any warnings?')).toContain("this public copy doesn't have")
    expect(ask('any warnings?')).toContain('mausam.imd.gov.in')
  })

  it("summarises Wetcast's own model forecast", () => {
    const point = (h: number, temperature: number) => ({
      time: `2026-11-26T${String(h).padStart(2, '0')}:00:00Z`,
      lead_hours: h,
      temperature,
      temperature_lower: temperature - 1,
      temperature_upper: temperature + 1,
      humidity: 60 + h,
      humidity_lower: 50,
      humidity_upper: 70,
      precipitation: 0.5,
      precipitation_lower: 0,
      precipitation_upper: 1,
      rain_chance: 0.3,
    })
    const data = {
      city: { id: 'delhi', name: 'Delhi', latitude: 28.65, longitude: 77.23 },
      issued_at: '2026-11-26T03:00:00Z',
      models: [{ model: 'ensemble', display_name: 'Ensemble', points: [point(4, 18), point(8, 24), point(12, 20)] }],
    } as unknown as Predictions
    expect(ask("what does Wetcast's model expect", { predictions: { kind: 'ok', data } })).toBe(
      "Wetcast's Ensemble model for Delhi, next 3 hours: 18°C at its coldest (around 09:30) and 24°C at its warmest (around 13:30), humidity 64% to 72%, and about 2 mm of rain (highest hourly chance of rain 30%). Issued at 08:30, updated every 3 hours.",
    )
  })

  it('points to the nearest covered city outside the coverage', () => {
    const text = ask('own model forecast', {
      predictions: { kind: 'unsupported', detail: '', supported: [{ id: 'jaipur', name: 'Jaipur', latitude: 26.91, longitude: 75.79 }] },
    })
    expect(text).toBe("Wetcast's own models forecast for 1 cities in India, and Delhi isn't one of them. The nearest is Jaipur, 240 km away: ask about it by name.")
  })

  it('does not suggest a covered city that is far away', () => {
    const text = composeAnswer(
      parseQuestion('own model forecast'),
      { place: { ...delhi, latitude: 51.5, longitude: -0.12 }, predictions: { kind: 'unsupported', detail: '', supported: [{ id: 'delhi', name: 'Delhi', latitude: 28.65, longitude: 77.23 }] } },
      'London',
      fmt,
    ).text
    expect(text).toBe("Wetcast's own models forecast for 1 cities in India, and London isn't one of them. The Models page lists them.")
  })

  it('reports the test scores', () => {
    const s = (mae: number) => ({ mae, rmse: 0, r2: 0, n: 1, unit: '' })
    const models = [
      {
        model: 'ensemble',
        display_name: 'Ensemble',
        test: { temperature: s(0.9), humidity: s(5.47), precipitation: s(0.21) },
        persistence_baseline: { temperature: s(1.13), humidity: s(6.92), precipitation: s(0.26) },
        data: { splits: { test: ['2026-01-01T00:00', '2026-10-31T23:00'] } },
      },
    ] as unknown as ModelMetrics[]
    expect(ask('how accurate is it', { models })).toBe(
      "On data it never saw (2026-01 to 2026-10), Wetcast's Ensemble model was off by an average of 0.9 °C for temperature, 5.5% for humidity and 0.21 mm for hourly rain, over the next 24 hours. Simply repeating yesterday's weather was off by 1.1 °C, 6.9% and 0.26 mm. The Models page has every model's scores.",
    )
  })

  it('has help text for questions it does not understand', () => {
    expect(HELP_TEXT).toContain('Will it rain in Jaipur tomorrow?')
  })
})
