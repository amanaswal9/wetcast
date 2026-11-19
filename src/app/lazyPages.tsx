import { lazy } from 'react'
import { GroupBox, Skeleton } from '../components/retro'
import { loaders } from './pageLoaders'

export const Dashboard = lazy(() => loaders.dashboard().then((m) => ({ default: m.Dashboard })))
export const ForecastPage = lazy(() => loaders.forecast().then((m) => ({ default: m.ForecastPage })))
export const MapPage = lazy(() => loaders.map().then((m) => ({ default: m.MapPage })))
export const AnalyticsPage = lazy(() => loaders.analytics().then((m) => ({ default: m.AnalyticsPage })))
export const ModelsPage = lazy(() => loaders.models().then((m) => ({ default: m.ModelsPage })))
export const LocationsPage = lazy(() => loaders.locations().then((m) => ({ default: m.LocationsPage })))
export const AboutPage = lazy(() => loaders.about().then((m) => ({ default: m.AboutPage })))

/** Shown for the moment a page's code is downloading. */
export function PageLoading() {
  return (
    <div aria-busy="true">
      <p className="sr-only" role="status">
        Loading page
      </p>
      <GroupBox title="Loading">
        <Skeleton height={220} />
      </GroupBox>
    </div>
  )
}
