import { describe, expect, it } from 'vitest'
import { indiaFirst } from './api/openMeteo'
import { INDIA_REGIONS, indiaRegion } from './indiaRegions'

describe('indiaRegion', () => {
  it('knows all 28 states and 8 union territories', () => {
    expect(INDIA_REGIONS).toHaveLength(36)
  })

  it('finds a state or union territory by its name or a common other name', () => {
    expect(indiaRegion('Goa')?.capital).toBe('Panjim')
    expect(indiaRegion('panaji')?.name).toBe('Goa')
    expect(indiaRegion('tamil nadu')?.capital).toBe('Chennai')
    expect(indiaRegion('J&K')?.name).toBe('Jammu and Kashmir')
    expect(indiaRegion('Jammu & Kashmir')?.capital).toBe('Srinagar')
    expect(indiaRegion('Orissa')?.name).toBe('Odisha')
    expect(indiaRegion('Pondicherry')?.name).toBe('Puducherry')
    expect(indiaRegion('Kerala India')?.capital).toBe('Thiruvananthapuram')
  })

  it('takes two-letter short names only in capitals', () => {
    expect(indiaRegion('UP')?.name).toBe('Uttar Pradesh')
    expect(indiaRegion('up')).toBeUndefined()
    expect(indiaRegion('mp')).toBeUndefined()
  })

  it('leaves towns and places named like their state to the ordinary search', () => {
    expect(indiaRegion('Chandigarh')).toBeUndefined()
    expect(indiaRegion('Puducherry')).toBeUndefined()
    expect(indiaRegion('Jaipur')).toBeUndefined()
    expect(indiaRegion('London')).toBeUndefined()
  })
})

// A geocoding result as Open-Meteo sends it.
function result(id: number, name: string, countryCode: string, extra: Record<string, unknown> = {}) {
  return { id, name, country_code: countryCode, latitude: 0, longitude: 0, ...extra }
}

describe('indiaFirst', () => {
  it('lists a notable Indian town before foreign places of the same name', () => {
    const raw = {
      results: [
        result(1, 'Hyderabad', 'PK', { population: 1921275, feature_code: 'PPLA2' }),
        result(2, 'Hyderabad', 'IN', { population: 6993262, feature_code: 'PPLA' }),
        result(3, 'Leh', 'FR', { population: 170000 }),
        result(4, 'Leh', 'IN', { feature_code: 'PPLA2' }),
      ],
    }
    expect(indiaFirst(raw).map((p) => p.id)).toEqual(['2', '4', '1', '3'])
  })

  it('keeps a small Indian village behind a foreign city', () => {
    const raw = { results: [result(1, 'Paris', 'FR', { population: 2138551, feature_code: 'PPLC' }), result(2, 'Paris', 'IN', { feature_code: 'PPL' })] }
    expect(indiaFirst(raw).map((p) => p.id)).toEqual(['1', '2'])
  })

  it('handles no results', () => {
    expect(indiaFirst({})).toEqual([])
  })
})
