import { describe, expect, it } from 'vitest'
import { publicDataFile } from './weatherai'

// The public copy answers some API addresses from exported files (backend/scripts/export_public_data.py).
describe('publicDataFile', () => {
  it('maps the model, coverage and evaluation addresses to their files', () => {
    expect(publicDataFile('/api/models')).toBe('data/models.json')
    expect(publicDataFile('/api/coverage')).toBe('data/coverage.json')
    expect(publicDataFile('/api/models/lstm/evaluation?include_samples=false')).toBe('data/evaluation/lstm.json')
    expect(publicDataFile('/api/models/cnn_lstm/evaluation?city=port_blair')).toBe('data/evaluation/cnn_lstm/port_blair.json')
    expect(publicDataFile('/api/predictions?city=delhi')).toBe('data/predictions/delhi.json')
  })

  it('leaves everything that needs the server unmapped', () => {
    for (const path of ['/api/track-record?days=30', '/api/alerts?latitude=1&longitude=2', '/api/assistant/status', '/api/places', '/api/health']) {
      expect(publicDataFile(path)).toBeNull()
    }
    // A point (not a city) and a full evaluation with every city's samples have no file.
    expect(publicDataFile('/api/predictions?latitude=28.6&longitude=77.2')).toBeNull()
    expect(publicDataFile('/api/models/lstm/evaluation')).toBeNull()
  })

  it('never builds a path from unexpected characters', () => {
    expect(publicDataFile('/api/predictions?city=../secret')).toBeNull()
    expect(publicDataFile('/api/models/lstm/evaluation?city=a/b')).toBeNull()
    expect(publicDataFile('/api/models/LSTM/evaluation?include_samples=false')).toBeNull()
  })
})
