import { Contrast, LocateFixed, Moon, RefreshCw, Star } from 'lucide-react'
import { Suspense, useCallback, useEffect, useState } from 'react'
import { Button, ErrorStack, TitleButton, Window } from '../components/retro'
import { buildSummary } from '../features/dashboard/buildSummary'
import { CitySearch } from '../features/search/CitySearch'
import { usePlace } from '../hooks/usePlace'
import { useResource } from '../hooks/useResource'
import { DesktopArt } from './DesktopArt'
import { MAX_SAVED, useSavedPlaces } from '../hooks/useSavedPlaces'
import { useSpeech } from '../hooks/useSpeech'
import { useOnline } from '../hooks/useOnline'
import { useReducedMotion } from '../hooks/useReducedMotion'
import { useTheme } from '../hooks/useTheme'
import { getAirQuality, getForecast } from '../lib/api/openMeteo'
import { placeShortLabel } from '../lib/format'
import { useFormat } from '../lib/units'
import { setAlertNotifications, useAlertNotificationsEnabled } from '../lib/alertNotifications'
import { getAlerts, getHealth } from '../lib/api/weatherai'
import { useAlertNotifications } from '../hooks/useAlertNotifications'
import { prefetchPlace } from '../lib/prefetch'
import type { Place } from '../types/weather'
import { ErrorBoundary } from './ErrorBoundary'
import { AboutPage, AnalyticsPage, AssistantPage, Dashboard, ForecastPage, LocationsPage, MapPage, ModelsPage, PageLoading } from './lazyPages'
import { loaders, preloadPages } from './pageLoaders'
import { PAGES, usePage, useUnknownPage } from './pages'
import { PlannedPage } from './PlannedPage'
import { Taskbar } from './Taskbar'
import { HAS_PUBLIC_DATA, HAS_SERVER, sitePath } from '../lib/site'

const MINUTE = 60_000

// The whole app: one desktop-style window with the menu bar, the current page and the taskbar.
// Forecast, air quality and server health are loaded here once and shared by the pages.
export default function App() {
  const page = usePage()
  const unknownPage = useUnknownPage()
  const pageInfo = PAGES.find((p) => p.id === page) ?? PAGES[0]
  const [place, setPlace] = usePlace()
  const saved = useSavedPlaces()
  const [refreshToken, setRefreshToken] = useState(0)
  const { theme, toggleNight, toggleContrast } = useTheme()
  const speech = useSpeech()
  const [minimized, setMinimized] = useState(false)
  // After the minimise animation the window is hidden (still mounted, so it keeps its state).
  const [hiddenAway, setHiddenAway] = useState(false)
  const [animateWindow, setAnimateWindow] = useState(false) // no animation on first load
  const reduceMotion = useReducedMotion()
  const online = useOnline()
  const minimize = () => {
    setAnimateWindow(true)
    setMinimized(true)
    if (reduceMotion) setHiddenAway(true) // no animation will run to say it ended
  }
  const restore = () => {
    setAnimateWindow(true)
    setMinimized(false)
    setHiddenAway(false)
  }
  // Choosing a page (Start menu, quick launch, voice) brings a minimised window back.
  const [shownPage, setShownPage] = useState(page)
  if (shownPage !== page) {
    setShownPage(page)
    if (minimized) restore()
  }
  const [maximized, setMaximized] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [locating, setLocating] = useState(false)

  const placeKey = `${place.latitude.toFixed(2)},${place.longitude.toFixed(2)}`
  const forecast = useResource(placeKey, ({ signal, fresh }) => getForecast(place, { signal, fresh }), 10 * MINUTE)
  // Air quality is asked for once the forecast is in, so it never holds up the first screen.
  const airKey = forecast.data !== undefined || forecast.status === 'error' ? placeKey : null
  const air = useResource(airKey, ({ signal, fresh }) => getAirQuality(place, { signal, fresh }), 30 * MINUTE)
  const fmt = useFormat()
  const summary = forecast.data ? buildSummary(place, forecast.data, fmt) : null
  const health = useResource('health', ({ signal }) => getHealth(signal), 5 * MINUTE)
  const modelStatus = health.data
    ? health.data.models.length > 0
      ? `Wetcast models: ${health.data.models.length} ready`
      : 'Wetcast models: none trained'
    : health.status === 'error'
      ? HAS_SERVER
        ? 'Wetcast models: offline'
        : HAS_PUBLIC_DATA
          ? 'Wetcast models: updated every 3 h'
          : 'Wetcast models: on the full setup'
      : 'Wetcast models: checking…'

  const title = `Wetcast – ${placeShortLabel(place)}`

  useEffect(() => {
    document.title = page === 'dashboard' ? title : `${pageInfo.label} – Wetcast`
  }, [page, pageInfo.label, title])

  // The other pages' code downloads once the opening weather is in (or has failed), so on a slow
  // connection it doesn't hold up the first screen.
  const firstWeatherSettled = forecast.data !== undefined || forecast.status === 'error'
  useEffect(() => {
    if (firstWeatherSettled) preloadPages()
  }, [firstWeatherSettled])

  // Hourglass pointer while the weather is loading or refreshing (see html[data-busy] in index.css).
  const busy = forecast.status === 'loading' || forecast.refreshing || locating
  useEffect(() => {
    document.documentElement.toggleAttribute('data-busy', busy)
  }, [busy])

  // Once the Dashboard's weather is in, quietly fetch what the Forecast page needs for this place.
  const dashboardReady = forecast.data !== undefined
  useEffect(() => {
    if (!dashboardReady) return
    return prefetchPlace(place)
  }, [dashboardReady, place])

  const { stop: stopSpeech } = speech
  const selectPlace = useCallback(
    (next: Place) => {
      setPlace(next)
      setNotice(null)
      stopSpeech()
    },
    [setPlace, stopSpeech],
  )

  function refresh() {
    setNotice(null)
    forecast.reload()
    air.reload()
    setRefreshToken((t) => t + 1)
  }

  const placeSaved = saved.isSaved(place)

  const notificationsOn = useAlertNotificationsEnabled()
  useAlertNotifications(place)
  async function toggleNotifications() {
    const result = await setAlertNotifications(!notificationsOn, async () =>
      (await getAlerts(place.latitude, place.longitude, place.countryCode)).alerts,
    )
    setNotice(
      result === 'on'
        ? `Warning notifications on for ${place.name}, while Wetcast is open. Official warnings are connected for India and the US.`
        : result === 'off'
          ? 'Warning notifications off.'
          : result === 'blocked'
            ? 'Notifications are blocked for this site. Allow them in your browser settings, then try again.'
            : "This browser can't show notifications.",
    )
  }

  function toggleSaved() {
    if (placeSaved) {
      saved.remove(place)
      setNotice(`${place.name} removed from saved places.`)
      return
    }
    const result = saved.add(place)
    setNotice(
      result === 'full'
        ? `You can save up to ${MAX_SAVED} places. Remove one on the Locations page first.`
        : `${place.name} saved. Find it on the Locations page.`,
    )
  }

  function openPlace(next: Place) {
    selectPlace(next)
    window.location.hash = '#/dashboard'
  }

  function locate() {
    if (locating) return
    if (!('geolocation' in navigator)) {
      setNotice("Location isn't available in this browser. Search for a city instead.")
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false)
        selectPlace({
          id: 'my-location',
          name: 'My location',
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        })
      },
      (error) => {
        setLocating(false)
        setNotice(
          error.code === error.PERMISSION_DENIED
            ? 'Location access is blocked. Allow it in your browser, or search for a city instead.'
            : "Couldn't find your location. Search for a city instead.",
        )
      },
      { timeout: 10_000, maximumAge: 10 * MINUTE },
    )
  }

  let status = 'Ready'
  if (!online) status = 'Offline: no new weather until you reconnect.'
  else if (locating) status = 'Finding your location…'
  else if (forecast.status === 'loading' || forecast.status === 'idle') status = 'Loading weather…'
  else if (forecast.refreshing) status = 'Refreshing…'
  else if (forecast.status === 'error') status = forecast.data ? "Couldn't refresh. Showing earlier data." : "Couldn't load the weather."

  // Bottom padding always clears the fixed taskbar.
  const frame = maximized ? 'pb-[52px]' : 'pb-[52px] sm:px-4 sm:pt-4 sm:pb-[64px] md:px-6 md:pt-6'
  // Keeps the window clear of notches and rounded corners (needs viewport-fit=cover in index.html).
  const safeArea = { padding: 'env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left)' }

  return (
    <>
      <a
        href="#content"
        onClick={(event) => {
          // Pages use the URL hash, so move focus without changing it.
          event.preventDefault()
          document.getElementById('content')?.focus()
        }}
        className="r-btn sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50"
      >
        <span>Skip to content</span>
      </a>
      <DesktopArt />
      <div style={safeArea} className="relative z-[1]">
      <div className={`min-h-dvh ${frame}`}>
        <div
          // No animation on first load: the page's static frame is already showing.
          hidden={hiddenAway}
          inert={minimized}
          data-state={minimized ? 'closing' : 'open'}
          data-animate={animateWindow ? 'true' : undefined}
          onAnimationEnd={(event) => {
            // Only the window's own animation; animations inside it (loading shimmer) bubble up too.
            if (event.target === event.currentTarget && minimized) setHiddenAway(true)
          }}
          className={`r-window-anim ${maximized ? 'w-full' : 'mx-auto w-full max-w-[1200px]'}`}
        >
          <Window
            headingLevel={1}
            title={title}
            icon={<img src={sitePath('favicon.svg')} width={16} height={16} alt="" />}
            controls={
              <>
                <TitleButton glyph="minimize" label="Minimise" onClick={minimize} />
                <TitleButton
                  glyph={maximized ? 'restore' : 'maximize'}
                  label={maximized ? 'Restore' : 'Maximise'}
                  onClick={() => setMaximized((m) => !m)}
                  className="hidden sm:inline-flex"
                />
              </>
            }
          >
            <nav
              // On phones the taskbar's Start menu and quick launch take over, keeping the header short.
              aria-label="Pages"
              className="r-menubar max-sm:hidden"
            >
              {PAGES.map((p) => (
                <a
                  key={p.id}
                  href={`#/${p.id}`}
                  // Start loading the page's code as soon as a pointer or finger reaches it.
                  onPointerEnter={() => void loaders[p.id]().catch(() => undefined)}
                  onPointerDown={() => void loaders[p.id]().catch(() => undefined)}
                  onFocus={() => void loaders[p.id]().catch(() => undefined)}
                  className="r-menu-item"
                  aria-current={page === p.id && unknownPage === null ? 'page' : undefined}
                >
                  {p.label}
                </a>
              ))}
            </nav>
            <div className="r-divider max-sm:hidden" />
            <div className="flex flex-wrap items-center gap-1.5 p-1.5">
              <CitySearch
                onSelect={selectPlace}
                voice
                onVoicePage={(next) => {
                  window.location.hash = `#/${next}`
                }}
              />
              <div
                // Icon-only buttons on phones, so search and these fit on one row.
                className="r-toolbar flex flex-wrap gap-1.5"
              >
                <Button onClick={locate} aria-busy={locating} icon={<LocateFixed size={14} />}>
                  <span className="max-sm:sr-only">{locating ? 'Locating…' : 'My location'}</span>
                </Button>
                <Button aria-pressed={placeSaved} onClick={toggleSaved} icon={<Star size={14} />}>
                  <span className="max-sm:sr-only">{placeSaved ? 'Saved' : 'Save city'}</span>
                </Button>
                <Button onClick={refresh} icon={<RefreshCw size={14} />}>
                  <span className="max-sm:sr-only">Refresh</span>
                </Button>
                <Button aria-pressed={theme === 'night'} onClick={toggleNight} icon={<Moon size={14} />} className="max-sm:hidden">
                  Dark
                </Button>
                <Button aria-pressed={theme === 'dark'} onClick={toggleContrast} icon={<Contrast size={14} />} className="max-sm:hidden">
                  High contrast
                </Button>
              </div>
            </div>
            <div className="r-divider" />
            <main id="content" tabIndex={-1} className="min-w-0 p-2 outline-none sm:p-3">
              <ErrorBoundary resetKey={`${page}:${place.id}`}>
              <Suspense fallback={<PageLoading />}>
              {unknownPage !== null && (
                <ErrorStack
                  caption="Wetcast"
                  kind="info"
                  title="Not found."
                  actions={
                    <Button
                      onClick={() => {
                        window.location.hash = '#/dashboard'
                      }}
                    >
                      Go to the Dashboard
                    </Button>
                  }
                >
                  <p className="m-0">
                    There&apos;s no page called &quot;{unknownPage.slice(0, 40)}&quot;. Pick a page from the menu or the Start menu.
                  </p>
                </ErrorStack>
              )}
              {page === 'dashboard' && unknownPage === null && (
                <Dashboard place={place} forecast={forecast} air={air} summary={summary} theme={theme} speech={speech} />
              )}
              {page === 'forecast' && (
                <ForecastPage place={place} theme={theme} refreshToken={refreshToken} onSelectPlace={selectPlace} />
              )}
              {page === 'map' && <MapPage place={place} theme={theme} refreshToken={refreshToken} onSelectPlace={selectPlace} />}
              {page === 'assistant' && <AssistantPage place={place} />}
              {page === 'models' && <ModelsPage theme={theme} />}
              {page === 'about' && <AboutPage theme={theme} />}
              {page === 'analytics' && <AnalyticsPage place={place} theme={theme} />}
              {page === 'locations' && (
                <LocationsPage place={place} saved={saved} theme={theme} refreshToken={refreshToken} onOpen={openPlace} />
              )}
              {!pageInfo.ready && <PlannedPage page={pageInfo} />}
              </Suspense>
              </ErrorBoundary>
            </main>
            <div className="flex gap-0.5 pt-0.5 text-[0.92em]">
              <div className="r-status-field min-w-0 flex-1" role="status">
                {notice ?? status}
              </div>
              <div className="r-status-field hidden sm:block">Source: Open-Meteo</div>
              <div className="r-status-field hidden tabular-nums sm:block">
                {forecast.data ? `Updated ${fmt.clock(new Date(forecast.data.fetchedAt))}` : 'Not updated yet'}
              </div>
              <div className="r-status-field hidden md:block">{modelStatus}</div>
            </div>
          </Window>
        </div>
      </div>
      </div>
      <Taskbar
        title={title}
        page={unknownPage === null ? page : null}
        minimized={minimized}
        onToggleWindow={() => (minimized ? restore() : minimize())}
        darkMode={theme === 'night'}
        onToggleDark={toggleNight}
        highContrast={theme === 'dark'}
        onToggleContrast={toggleContrast}
        warningNotifications={notificationsOn}
        onToggleNotifications={() => void toggleNotifications()}
      />
    </>
  )
}
