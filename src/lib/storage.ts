// localStorage helpers that never throw. Storage can be blocked (private
// windows, strict privacy settings), so callers always get a fallback.
export function readJson<T>(key: string, fallback: T, isValid: (value: unknown) => value is T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    const parsed: unknown = JSON.parse(raw)
    return isValid(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

// Save a value as JSON.
export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage unavailable: the preference simply won't persist.
  }
}

// Read a plain string, or null if missing or unavailable.
export function readString(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

// Save a plain string.
export function writeString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Ignore: see writeJson.
  }
}
