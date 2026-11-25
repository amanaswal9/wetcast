import { useEffect, useState } from 'react'

export type PageId = 'dashboard' | 'forecast' | 'map' | 'assistant' | 'analytics' | 'models' | 'locations' | 'about'

export interface PageInfo {
  id: PageId
  label: string
  // What the page will contain; shown while it is still being built.
  plan: string
  ready: boolean
}

// Every page in menu order. The id is also the URL hash, for example #/map.
export const PAGES: PageInfo[] = [
  { id: 'dashboard', label: 'Dashboard', plan: '', ready: true },
  { id: 'forecast', label: 'Forecast', plan: '', ready: true },
  { id: 'map', label: 'Map', plan: '', ready: true },
  { id: 'assistant', label: 'Ask', plan: '', ready: true },
  { id: 'analytics', label: 'Analytics', plan: '', ready: true },
  { id: 'models', label: 'Models', plan: '', ready: true },
  { id: 'locations', label: 'Locations', plan: '', ready: true },
  { id: 'about', label: 'About', plan: '', ready: true },
]

// Other names people type for a page: "#/ask" opens the Ask page, whose id is "assistant".
const ALIASES: Record<string, PageId> = { ask: 'assistant', home: 'dashboard', maps: 'map', model: 'models', places: 'locations' }

// The page part of the address: "#/forecast" -> "forecast", "#/ask" -> "assistant".
function hashId(): string {
  const id = window.location.hash.replace(/^#\/?/, '').toLowerCase()
  return ALIASES[id] ?? id
}

// The page the address names, or the Dashboard when it names none.
function pageFromHash(): PageId {
  const id = hashId()
  return PAGES.some((p) => p.id === id) ? (id as PageId) : 'dashboard'
}

// The address asked for when it isn't a page (e.g. "#/radar"), else null.
export function useUnknownPage(): string | null {
  const [id, setId] = useState(hashId)
  useEffect(() => {
    const onChange = () => setId(hashId())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return id && !PAGES.some((p) => p.id === id) ? id : null
}

// Hash-based page state, so pages are linkable without a router yet.
export function usePage(): PageId {
  const [page, setPage] = useState<PageId>(pageFromHash)

  useEffect(() => {
    const onChange = () => setPage(pageFromHash())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  return page
}
