import { useEffect, useState } from 'react'

export type PageId = 'dashboard' | 'forecast' | 'analytics' | 'models' | 'locations' | 'about'

export interface PageInfo {
  id: PageId
  label: string
  /** What the page will contain; shown while it is still being built. */
  plan: string
  ready: boolean
}

export const PAGES: PageInfo[] = [
  { id: 'dashboard', label: 'Dashboard', plan: '', ready: true },
  { id: 'forecast', label: 'Forecast', plan: '', ready: true },
  { id: 'analytics', label: 'Analytics', plan: '', ready: true },
  { id: 'models', label: 'Models', plan: '', ready: true },
  { id: 'locations', label: 'Locations', plan: '', ready: true },
  { id: 'about', label: 'About', plan: '', ready: true },
]

function pageFromHash(): PageId {
  const id = window.location.hash.replace(/^#\/?/, '')
  return PAGES.some((p) => p.id === id) ? (id as PageId) : 'dashboard'
}

/** Hash-based page state, so pages are linkable without a router yet. */
export function usePage(): PageId {
  const [page, setPage] = useState<PageId>(pageFromHash)

  useEffect(() => {
    const onChange = () => setPage(pageFromHash())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  return page
}
