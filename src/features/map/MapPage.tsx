import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, GroupBox } from '../../components/retro'
import { useResource } from '../../hooks/useResource'
import type { Theme } from '../../hooks/useTheme'
import { isAbort, toApiError } from '../../lib/api/http'
import { clearGridCache, getGridForecasts, gridFor, nearestPoint, uncachedPoints, type Bounds, type Grid, type GridPoint, type PointForecast, type ViewSize } from '../../lib/api/mapGrid'
import { getCoverage } from '../../lib/api/weatherai'
import { compass, latLonLabel, round } from '../../lib/format'
import { BANDS, bandFor, blowingTowards, LAYER_INFO, type MapLayer } from '../../lib/mapScales'
import type { Place } from '../../types/weather'

const LAYERS: MapLayer[] = ['temperature', 'rain', 'wind']
const WORLD: L.LatLngBoundsExpression = [
  [-85, -180],
  [85, 180],
]

/**
 * Basemap: OpenStreetMap's standard tiles (no key; fine for light use with attribution,
 * see https://operations.osmfoundation.org/policies/tiles/). Shown in greyscale by CSS
 * (.r-map) so the weather colours stand out.
 */
const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | Weather: <a href="https://open-meteo.com/">Open-Meteo</a>'

type Status = { kind: 'loading'; points: number } | { kind: 'waiting'; seconds: number } | { kind: 'ready' } | { kind: 'error'; message: string }

function toBounds(b: L.LatLngBounds): Bounds {
  return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() }
}

function hourLabel(time: number): string {
  return new Date(time).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function valueAt(f: PointForecast, layer: MapLayer, hour: number): number | null {
  if (layer === 'temperature') return f.temperature[hour] ?? null
  if (layer === 'rain') return f.precipitation[hour] ?? null
  return f.windSpeed[hour] ?? null
}

/** An arrow from the point's centre towards where the wind blows, longer for stronger wind. */
function windArrow(p: GridPoint, grid: Grid, speed: number, fromDegrees: number): L.LatLngExpression[][] {
  const cosLat = Math.max(Math.cos((p.latitude * Math.PI) / 180), 0.2)
  // Lengths are in degrees of latitude (equal distance in every direction); fit the smaller cell side.
  const cell = Math.min(grid.latSpacing, grid.lonSpacing * cosLat)
  const length = cell * (0.3 + 0.45 * Math.min(speed / 50, 1))
  const towards = (blowingTowards(fromDegrees) * Math.PI) / 180
  const at = (lat: number, lon: number, bearing: number, len: number): [number, number] => [
    lat + len * Math.cos(bearing),
    lon + (len * Math.sin(bearing)) / cosLat,
  ]
  const tail = at(p.latitude, p.longitude, towards + Math.PI, length / 2)
  const head = at(p.latitude, p.longitude, towards, length / 2)
  const barb = length * 0.4
  return [
    [tail, head],
    [at(head[0], head[1], towards + Math.PI - 0.5, barb), head, at(head[0], head[1], towards + Math.PI + 0.5, barb)],
  ]
}

function Legend({ layer }: { layer: MapLayer }) {
  const info = LAYER_INFO[layer]
  return (
    <div>
      <p className="m-0 mb-1">
        {info.description} ({info.unit}).
      </p>
      <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-[0.92em]" aria-label={`${info.label} key`}>
        {BANDS[layer].map((b) => (
          <li key={b.label} className="flex items-center gap-1.5 tabular-nums">
            <span aria-hidden="true" className="inline-block h-3 w-4 border border-[var(--dark)]" style={{ background: b.color }} />
            {b.label}
          </li>
        ))}
        {layer === 'rain' && <li className="text-[var(--text-muted)]">Empty square: less than 0.1 mm</li>}
      </ul>
    </div>
  )
}

interface MapPageProps {
  place: Place
  theme: Theme
  refreshToken: number
  onSelectPlace: (place: Place) => void
}

export function MapPage({ place, theme, refreshToken, onSelectPlace }: MapPageProps) {
  const reduceMotion = useReducedMotion()
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const overlayRef = useRef<L.LayerGroup | null>(null)
  const citiesRef = useRef<L.LayerGroup | null>(null)

  const [layer, setLayer] = useState<MapLayer>('temperature')
  const [hour, setHour] = useState(0)
  const [view, setView] = useState<{ bounds: Bounds; size: ViewSize } | null>(null)
  const [centre, setCentre] = useState<[number, number]>([place.latitude, place.longitude])
  // A clicked point belongs to the place it was picked on; choosing another place clears it.
  const [pickedFor, setPickedFor] = useState<{ placeId: string; at: [number, number] } | null>(null)
  const picked = pickedFor?.placeId === place.id ? pickedFor.at : null
  const placeIdRef = useRef(place.id)
  useEffect(() => {
    placeIdRef.current = place.id
  }, [place.id])
  const initial = useRef({ latitude: place.latitude, longitude: place.longitude, reduceMotion })
  const [data, setData] = useState<Map<string, PointForecast>>(() => new Map())
  const [status, setStatus] = useState<Status>({ kind: 'loading', points: 0 })
  const [retry, setRetry] = useState(0)
  const coverage = useResource('coverage', ({ signal }) => getCoverage(signal))

  // Create the map once.
  useEffect(() => {
    if (!container.current) return
    const start = initial.current
    const map = L.map(container.current, {
      center: [start.latitude, start.longitude],
      zoom: 6,
      minZoom: 3,
      maxZoom: 10,
      maxBounds: WORLD,
      maxBoundsViscosity: 1,
      worldCopyJump: false,
      preferCanvas: true,
      // The page scrolls past the map; the wheel zooms only once the map has been clicked or focused.
      scrollWheelZoom: false,
      zoomAnimation: !start.reduceMotion,
      fadeAnimation: !start.reduceMotion,
      markerZoomAnimation: !start.reduceMotion,
    })
    mapRef.current = map
    L.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 19, noWrap: true }).addTo(map)
    overlayRef.current = L.layerGroup().addTo(map)
    citiesRef.current = L.layerGroup().addTo(map)
    const update = () => {
      const size = map.getSize()
      setView({ bounds: toBounds(map.getBounds()), size: { width: size.x, height: size.y } })
      const c = map.getCenter()
      setCentre([c.lat, c.lng])
    }
    map.on('focus click', () => map.scrollWheelZoom.enable())
    map.on('blur mouseout', () => map.scrollWheelZoom.disable())
    map.on('moveend', update)
    map.on('resize', update)
    map.on('click', (e: L.LeafletMouseEvent) => setPickedFor({ placeId: placeIdRef.current, at: [e.latlng.lat, e.latlng.lng] }))
    update()
    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  // Follow the selected place.
  useEffect(() => {
    mapRef.current?.setView([place.latitude, place.longitude], mapRef.current.getZoom(), { animate: !reduceMotion })
  }, [place.latitude, place.longitude, reduceMotion])

  const grid = useMemo(() => (view ? gridFor(view.bounds, view.size) : null), [view])

  // Fetch points not cached yet (debounced while the map moves).
  const lastRefresh = useRef(refreshToken)
  useEffect(() => {
    if (!grid) return
    const fresh = lastRefresh.current !== refreshToken
    lastRefresh.current = refreshToken
    if (fresh) clearGridCache()
    // Points already cached (panning, or coming back to the page) load at once with no
    // "Loading" message; only new points wait for the map to stop moving and show it.
    const missing = uncachedPoints(grid.points).length
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      if (missing > 0) setStatus({ kind: 'loading', points: missing })
      getGridForecasts(grid.points, {
        signal: controller.signal,
        fresh,
        onWait: (ms) => setStatus({ kind: 'waiting', seconds: Math.ceil(ms / 1000) }),
      })
        .then((result) => {
          setData((prev) => new Map([...prev, ...result]))
          setStatus({ kind: 'ready' })
        })
        .catch((error: unknown) => {
          if (isAbort(error)) return
          setStatus({ kind: 'error', message: toApiError(error).message })
        })
    }, missing > 0 ? 350 : 0)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [grid, refreshToken, retry])

  const times = useMemo(() => {
    for (const p of grid?.points ?? []) {
      const f = data.get(p.key)
      if (f) return f.times
    }
    return []
  }, [data, grid])
  const hourIndex = Math.min(hour, Math.max(times.length - 1, 0))

  const target = picked ?? centre
  const selected = grid ? nearestPoint(grid.points, target[0], target[1]) : null
  const selectedForecast = selected ? data.get(selected.key) : undefined

  // Draw the squares or arrows for the chosen hour.
  useEffect(() => {
    const group = overlayRef.current
    if (!group || !grid) return
    group.clearLayers()
    const halfLat = grid.latSpacing / 2
    const halfLon = grid.lonSpacing / 2
    const outline = theme === 'dark' ? '#ffffff' : '#000000'
    for (const p of grid.points) {
      const f = data.get(p.key)
      if (!f) continue
      const value = valueAt(f, layer, hourIndex)
      const band = bandFor(layer, value)
      if (layer === 'wind') {
        const direction = f.windDirection[hourIndex]
        if (value === null || direction === null || !band) continue
        L.polyline(windArrow(p, grid, value, direction), { color: band.color, weight: 3, interactive: false }).addTo(group)
      } else if (band) {
        L.rectangle(
          [
            [p.latitude - halfLat, p.longitude - halfLon],
            [p.latitude + halfLat, p.longitude + halfLon],
          ],
          { stroke: false, fillColor: band.color, fillOpacity: 0.55, interactive: false },
        ).addTo(group)
      }
    }
    if (selected) {
      L.rectangle(
        [
          [selected.latitude - halfLat, selected.longitude - halfLon],
          [selected.latitude + halfLat, selected.longitude + halfLon],
        ],
        { color: outline, weight: 2, dashArray: '4 3', fill: false, interactive: false },
      ).addTo(group)
    }
  }, [data, grid, layer, hourIndex, selected, theme])

  // Mark the cities WeatherAI's own models cover.
  useEffect(() => {
    const group = citiesRef.current
    if (!group) return
    group.clearLayers()
    for (const c of coverage.data ?? []) {
      L.circleMarker([c.latitude, c.longitude], {
        radius: 5,
        color: theme === 'dark' ? '#ffffff' : '#000000',
        weight: 2,
        fillColor: theme === 'dark' ? '#000000' : '#ffffff',
        fillOpacity: 1,
      })
        .bindTooltip(`${c.name}: covered by WeatherAI's models`, { direction: 'top' })
        .addTo(group)
    }
  }, [coverage.data, theme])

  const openForecast = () => {
    if (!selected) return
    onSelectPlace({
      id: `map:${selected.key}`,
      name: latLonLabel(selected.latitude, selected.longitude),
      latitude: selected.latitude,
      longitude: selected.longitude,
    })
    window.location.hash = '#/forecast'
  }

  const hourText = times[hourIndex] !== undefined ? hourLabel(times[hourIndex]) : '–'
  const detail = (() => {
    if (!selectedForecast) return null
    const t = selectedForecast.temperature[hourIndex]
    const r = selectedForecast.precipitation[hourIndex]
    const w = selectedForecast.windSpeed[hourIndex]
    const d = selectedForecast.windDirection[hourIndex]
    return [
      ['Temperature', t === null ? 'n/a' : `${round(t)} °C`],
      ['Rain in the hour', r === null ? 'n/a' : `${r.toFixed(1)} mm`],
      ['Wind', w === null ? 'n/a' : `${round(w)} km/h${d === null ? '' : ` from ${compass(d)}`}`],
    ] as const
  })()

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <GroupBox title="Weather map">
        <div className="mb-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="Map layer">
          {LAYERS.map((l) => (
            <Button key={l} aria-pressed={layer === l} onClick={() => setLayer(l)}>
              {LAYER_INFO[l].label}
            </Button>
          ))}
        </div>
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <Button onClick={() => setHour(Math.max(hourIndex - 1, 0))} disabled={hourIndex === 0} aria-label="One hour earlier">
            ◀
          </Button>
          <input
            type="range"
            className="r-slider min-w-[140px] flex-1"
            min={0}
            max={Math.max(times.length - 1, 0)}
            value={hourIndex}
            onChange={(e) => setHour(Number(e.target.value))}
            aria-label="Forecast hour"
            aria-valuetext={hourText}
            disabled={times.length === 0}
          />
          <Button onClick={() => setHour(Math.min(hourIndex + 1, times.length - 1))} disabled={hourIndex >= times.length - 1} aria-label="One hour later">
            ▶
          </Button>
          <span className="min-w-[13ch] tabular-nums" aria-live="polite">
            {hourText}
          </span>
        </div>
        <div className="r-sunken p-0.5">
          <div
            ref={container}
            data-theme={theme}
            className="r-map h-[clamp(320px,60vh,620px)] w-full"
            role="application"
            aria-label="Weather map. Drag or use the arrow keys to move, plus and minus to zoom (or the mouse wheel after clicking the map). Click a square for its values."
          />
        </div>
        <div className="mt-1 flex flex-wrap justify-between gap-x-3 text-[0.92em]" role="status">
          <span>
            {status.kind === 'loading'
              ? `Loading forecasts for ${status.points} points…`
              : status.kind === 'waiting'
                ? `Waiting ${status.seconds} s to stay within Open-Meteo's free limit of requests per minute…`
                : status.kind === 'error'
                ? status.message
                : grid &&
                  `${grid.points.length} points, ${grid.latSpacing === grid.lonSpacing ? `${grid.latSpacing}°` : `${grid.latSpacing}° (north–south) by ${grid.lonSpacing}° (east–west)`} apart. Times are in your time zone.`}
          </span>
          {status.kind === 'error' && <Button onClick={() => setRetry((n) => n + 1)}>Try again</Button>}
        </div>
      </GroupBox>

      <div className="grid gap-3 md:grid-cols-2">
        <GroupBox title="Key">
          <Legend layer={layer} />
          {(coverage.data?.length ?? 0) > 0 && (
            <p className="m-0 mt-2 flex items-center gap-1.5 text-[0.92em]">
              <svg width="12" height="12" aria-hidden="true">
                <circle cx="6" cy="6" r="4.5" fill="var(--field)" stroke="var(--dark)" strokeWidth="2" />
              </svg>
              A city WeatherAI's own models cover.
            </p>
          )}
        </GroupBox>
        <GroupBox title={picked ? 'Selected point' : 'Point at the map centre'}>
          {selected && detail ? (
            <>
              <p className="m-0 mb-1 tabular-nums">
                {latLonLabel(selected.latitude, selected.longitude)}, {hourText}
              </p>
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tabular-nums">
                {detail.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt>{k}</dt>
                    <dd className="m-0">{v}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button onClick={openForecast}>Open forecast for this point</Button>
                {picked && <Button onClick={() => setPickedFor(null)}>Back to map centre</Button>}
              </div>
            </>
          ) : (
            <p className="m-0">{status.kind === 'error' ? 'No data for this point.' : 'Loading…'}</p>
          )}
        </GroupBox>
      </div>

      <GroupBox title="About this map">
        <p className="m-0 max-w-[75ch]">
          Each square shows Open-Meteo's forecast at its centre point. This is weather-model data, not measurements, and values between points
          are not filled in, so a square can miss a shower or a hill that its centre point doesn't. The grid gets finer as you zoom in. This map
          uses third-party forecasts; WeatherAI's own models only cover the marked cities and are on the Forecast page.
        </p>
      </GroupBox>
    </div>
  )
}
