/**
 * Each page is its own JavaScript file, downloaded the first time it's opened,
 * so the first screen loads less code (noticeable on phones). After the first
 * page is up, the rest are fetched in the background so switching stays instant.
 */
export const loaders = {
  dashboard: () => import('../features/dashboard/Dashboard'),
  forecast: () => import('../features/forecast/ForecastPage'),
  map: () => import('../features/map/MapPage'),
  assistant: () => import('../features/assistant/AssistantPage'),
  analytics: () => import('../features/analytics/AnalyticsPage'),
  models: () => import('../features/models/ModelsPage'),
  locations: () => import('../features/locations/LocationsPage'),
  about: () => import('../features/about/AboutPage'),
}

let preloaded = false

/** Fetch every page's code once the browser is idle. Failures are ignored: the page loads on demand anyway. */
export function preloadPages(): void {
  if (preloaded) return
  preloaded = true
  const run = () => Object.values(loaders).forEach((load) => load().catch(() => undefined))
  if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 4000 })
  else setTimeout(run, 1500)
}
