import type { ReactNode } from 'react'
import { DitherPicture, GroupBox, TextSkeleton } from '../../components/retro'
import { useResource } from '../../hooks/useResource'
import type { Theme } from '../../hooks/useTheme'
import { getModels, type ModelMetrics } from '../../lib/api/weatherai'
import { CHART_COLORS, MODEL_COLORS } from '../../lib/chartTheme'
import { LICENSE_NAME, LICENSE_URL, SOURCE_URL } from '../../lib/project'

const APP_VERSION = '0.3.0'

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-[inherit]">
      {children}
    </a>
  )
}

// One-line summary of the live evaluation results, read from the API.
function ResultsLine({ models }: { models: ModelMetrics[] }) {
  const best = [...models].sort((a, b) => a.test.temperature.mae - b.test.temperature.mae)[0]
  const t = best.test.temperature
  const base = best.persistence_baseline.temperature.mae
  const better = Math.round(((base - t.mae) / base) * 100)
  return (
    <p className="m-0">
      On the {best.data.splits.test[0].slice(0, 10)} to {best.data.splits.test[1].slice(0, 10)} test period, the most accurate
      temperature model was the {best.display_name}, off by {t.mae.toFixed(2)} °C on average over the next 24 hours: {better}% less
      than simply repeating the same hour from the day before. The <a href="#/models" className="text-[inherit]">Models page</a> has
      every result, including the ones that are less flattering.
    </p>
  )
}

function Swatch({ children }: { children: ReactNode }) {
  return (
    <svg width="34" height="14" aria-hidden="true" className="shrink-0">
      {children}
    </svg>
  )
}

// About page: how the forecasts are made, where the data comes from and their limits.
export function AboutPage({ theme }: { theme: Theme }) {
  const models = useResource('models', ({ signal }) => getModels(signal))
  const colors = CHART_COLORS[theme]
  const modelColor = MODEL_COLORS[theme].gru
  const patternId = `about-dither-${theme}`
  const first = models.data?.[0]

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <section className="r-group" aria-labelledby="about-title">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <DitherPicture caption="sky.png" className="shrink-0 self-start" />
          <div className="min-w-0 max-w-[68ch]">
            <h2 id="about-title" className="m-0 font-pixel text-[32px] leading-none font-normal">
              Wetcast
            </h2>
            <p className="m-0 mt-1 text-[var(--text-muted)]">Version {APP_VERSION}, models version 2</p>
            <p className="m-0 mt-3 text-[1.08em]">
              A weather forecasting project that trains its own neural networks on real data and shows, side by side, what they
              predict, what a professional forecast says, and how often each turned out right.
            </p>
            <p className="m-0 mt-2">
              Everyday weather comes from Open-Meteo for any city in the world. Wetcast&apos;s own models (LSTM, GRU, CNN-LSTM, a
              spatio-temporal Transformer, LightGBM and their ensemble) cover India: they trained on 40 cities across the country and were tested on 8 more they never saw.
            </p>
          </div>
        </div>
      </section>

      <GroupBox title="How the forecasts are made">
        <ol className="m-0 flex max-w-[75ch] flex-col gap-2 pl-5">
          <li>
            <b>Collect.</b> Four years of hourly weather (January 2023 to October 2026) for each city and four points about 55 km
            north, south, east and west of it. Looking at the neighbours is what makes the forecast spatial as well as temporal:
            weather arriving from one side shows up there first.
          </li>
          <li>
            <b>Prepare.</b> Each hour becomes 42 numbers: temperature, humidity, rain, pressure, wind and cloud at the five points,
            plus time of day, season and location. Gaps of up to 3 hours are filled; longer gaps are left out rather than guessed.
          </li>
          <li>
            <b>Split by time.</b> 2023–2024 for training, 2025 for checking progress, January–October 2026 as the final test. The
            models never see a later year while learning from an earlier one, and the data scaling is fitted on the training years
            only.
          </li>
          <li>
            <b>Train.</b> Each model reads the last {first?.data.lookback_hours ?? 48} hours and predicts the next{' '}
            {first?.data.horizon_hours ?? 24}. For temperature and humidity it predicts the change from the same hour the day before,
            which lets it focus on what&apos;s different about tomorrow.
          </li>
          <li>
            <b>Test honestly.</b> Settings were chosen on 2025 only; the 2026 test set was scored once. Every model is compared with
            a naive baseline and given an error range sized from its past mistakes.
          </li>
          <li>
            <b>Serve.</b> When you open a place in India, the server fetches the latest 48 hours, prepares them with exactly the same
            code and saved settings as training, and runs all three models. Each forecast is stored so it can be scored later.
          </li>
        </ol>
        <div className="mt-3 max-w-[75ch]">
          {models.data && models.data.length > 0 ? (
            <ResultsLine models={models.data} />
          ) : models.status === 'error' ? (
            <p className="m-0 text-[var(--text-muted)]">Live results appear here when the Wetcast server is running.</p>
          ) : (
            <TextSkeleton lines={2} />
          )}
        </div>
      </GroupBox>

      <GroupBox title="Reading the charts">
        <svg width="0" height="0" className="absolute" aria-hidden="true">
          <defs>
            <pattern id={patternId} width="4" height="4" patternUnits="userSpaceOnUse">
              <rect width="2" height="2" fill={modelColor} />
              <rect x="2" y="2" width="2" height="2" fill={modelColor} />
            </pattern>
          </defs>
        </svg>
        <p className="m-0 mb-2 max-w-[75ch]">The same visual code is used on every page, so you can always tell whose numbers you&apos;re looking at.</p>
        <ul className="m-0 flex max-w-[75ch] list-none flex-col gap-2 p-0">
          <li className="flex items-start gap-3">
            <Swatch>
              <line x1="0" y1="7" x2="34" y2="7" stroke={colors.past} strokeWidth="2" />
            </Swatch>
            <span>
              <b>Solid line:</b> hours that have already happened, as estimated by Open-Meteo&apos;s weather models. These are not
              thermometer readings.
            </span>
          </li>
          <li className="flex items-start gap-3">
            <Swatch>
              <line x1="0" y1="7" x2="34" y2="7" stroke={colors.forecast} strokeWidth="2" strokeDasharray="6 4" />
            </Swatch>
            <span>
              <b>Dashed line:</b> Open-Meteo&apos;s forecast, a third-party forecast built from national weather services&apos; models.
            </span>
          </li>
          <li className="flex items-start gap-3">
            <Swatch>
              <rect x="0" y="2" width="34" height="10" fill={`url(#${patternId})`} opacity="0.45" />
              <line x1="0" y1="7" x2="34" y2="7" stroke={modelColor} strokeWidth="2.5" />
            </Swatch>
            <span>
              <b>Coloured line with a dotted band:</b> a Wetcast model prediction. The band is its error range; on the test
              period it held the real value about three times out of four. Predictions are estimates, never certainties.
            </span>
          </li>
        </ul>
      </GroupBox>

      <GroupBox title="Where the data comes from">
        <div className="r-sunken overflow-x-auto">
          <table className="r-table min-w-[520px]">
            <caption className="sr-only">Data sources used by Wetcast</caption>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Used for</th>
                <th scope="col">Licence</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">
                  <Link href="https://open-meteo.com/">Open-Meteo</Link> forecast and geocoding
                </th>
                <td>Current conditions, forecasts, the weather map, city search, live model inputs</td>
                <td>CC BY 4.0</td>
              </tr>
              <tr>
                <th scope="row">Open-Meteo historical forecasts</th>
                <td>Training and testing the models</td>
                <td>CC BY 4.0</td>
              </tr>
              <tr>
                <th scope="row">Open-Meteo archive (Copernicus ERA5)</th>
                <td>Historical trends on the Analytics page</td>
                <td>CC BY 4.0</td>
              </tr>
              <tr>
                <th scope="row">Open-Meteo air quality (Copernicus CAMS)</th>
                <td>Air quality index</td>
                <td>CC BY 4.0</td>
              </tr>
              <tr>
                <th scope="row">
                  <Link href="https://sachet.ndma.gov.in/">NDMA Sachet</Link> (IMD and state authorities)
                </th>
                <td>Official weather warnings in India</td>
                <td>Public domain (as stated in its feed)</td>
              </tr>
              <tr>
                <th scope="row">
                  <Link href="https://www.weather.gov/">US National Weather Service</Link>
                </th>
                <td>Official weather warnings in the United States</td>
                <td>Public domain (US government)</td>
              </tr>
              <tr>
                <th scope="row">
                  <Link href="https://ollama.com/">Ollama</Link> with <Link href="https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507">Qwen3 4B Instruct</Link>
                </th>
                <td>Javed, the Ask page&apos;s assistant: a small open model running on Wetcast&apos;s own computer; it answers only from the data above</td>
                <td>Open source: Ollama MIT, Qwen3 Apache 2.0</td>
              </tr>
              <tr>
                <th scope="row">
                  <Link href="https://www.openstreetmap.org/copyright">OpenStreetMap</Link> tiles, drawn with{' '}
                  <Link href="https://leafletjs.com/">Leaflet</Link>
                </th>
                <td>The base map under the weather map</td>
                <td>ODbL (map data); Leaflet is BSD-2</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="m-0 mt-2 text-[0.92em] text-[var(--text-muted)]">
          Weather data by Open-Meteo.com. Map data © OpenStreetMap contributors. None of these services needs an API key, and none of them
          endorses this project.
        </p>
      </GroupBox>

      <GroupBox title="Keep the weather on screen">
        <p className="m-0 mb-2 max-w-[75ch]">
          Wetcast Mini is a small window with the weather now and for the next few hours, for the place you last opened here.
          Open it from the Start menu, or go to <a href="/mini/">/mini/</a>. Then keep it where you can see it:
        </p>
        <ul className="m-0 flex max-w-[75ch] flex-col gap-1.5 pl-5">
          <li>
            Windows PC or laptop: in Chrome or Edge, use the install button at the right of the address bar. It becomes its own
            small window and a Start menu app, which you can pin to the taskbar.
          </li>
          <li>Mac: in Safari, File, then Add to Dock. In Chrome, use the install button in the address bar.</li>
          <li>iPhone and iPad: in Safari, the Share button, then Add to Home Screen.</li>
          <li>Android phone: in Chrome, the menu, then Add to Home screen (or Install app).</li>
        </ul>
        <p className="m-0 mt-2 max-w-[75ch] text-[var(--text-muted)]">
          These open Wetcast Mini with one tap. True home-screen widgets on iPhone, Mac and Android can only come from apps
          built with Apple&apos;s and Google&apos;s own tools, which a website can&apos;t provide.
        </p>
      </GroupBox>

      <GroupBox title="Limits worth knowing">
        <ul className="m-0 flex max-w-[75ch] flex-col gap-1.5 pl-5">
          <li>
            The models only cover India, near the cities they were trained on. Away from those cities their accuracy is an estimate,
            measured on the eight held-out cities; each forecast says which kind of place it is for.
          </li>
          <li>
            They learn from Open-Meteo&apos;s model data, so they inherit its errors: they forecast what that model data will say,
            not a reading from a weather station.
          </li>
          <li>Rain is the hardest part: most hours are dry, and the models rarely predict heavy rain well.</li>
          <li>The error ranges were sized on 2025 and came out a little narrow for 2026 temperatures.</li>
          <li>
            Saved places are stored on the server under an anonymous ID for each browser, so they don&apos;t follow you to another
            device yet.
          </li>
          <li>
            Voice search uses your browser&apos;s own speech recognition: Chrome and Edge send the audio to their makers&apos; speech
            services, Safari to Apple&apos;s. Wetcast never receives the audio, only the words. Firefox doesn&apos;t offer it.
          </li>
        </ul>
      </GroupBox>

      <GroupBox title="Built with">
        <dl className="m-0 grid max-w-[75ch] grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
          <dt className="font-bold">Interface</dt>
          <dd className="m-0">React, TypeScript, Vite, Tailwind CSS, Radix, Lucide, Leaflet; charts are hand-drawn SVG</dd>
          <dt className="font-bold">Server</dt>
          <dd className="m-0">Python, FastAPI, SQLAlchemy, PostgreSQL</dd>
          <dt className="font-bold">Models</dt>
          <dd className="m-0">
            TensorFlow and Keras{first ? ` ${first.framework.keras}` : ''}, NumPy, pandas, scikit-learn
          </dd>
          <dt className="font-bold">Testing</dt>
          <dd className="m-0">pytest for the pipeline and API, TypeScript and oxlint for the interface</dd>
          <dt className="font-bold">Deployment</dt>
          <dd className="m-0">Docker or Podman, nginx</dd>
          <dt className="font-bold">Type</dt>
          <dd className="m-0">Noto Sans, Noto Sans Mono, Pixelify Sans and VT323, all under the SIL Open Font License and shipped with the app</dd>
        </dl>
        <p className="m-0 mt-3 max-w-[75ch]">
          The look is a tribute to late-1990s desktop software, rebuilt with modern accessibility: every control works from the
          keyboard, charts have table views, there&apos;s a dark mode and a high-contrast theme, and animation stops when your system asks for reduced
          motion.
        </p>
      </GroupBox>

      <GroupBox title="Free and open source">
        <p className="m-0 max-w-[75ch]">
          Wetcast is free software: you can use, study, share and change it under the{' '}
          <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer">
            {LICENSE_NAME}
          </a>
          . If you run a changed copy as a website, the licence asks you to offer its source to your visitors too.
        </p>
        <p className="m-0 mt-2 max-w-[75ch]">
          Everything it is built from is open as well: every library and font is under an open-source licence, Javed runs on an
          open model on Wetcast&apos;s own computer, and the data comes from open or public-domain sources (listed above). It uses no
          paid services, no trackers and no advertising.
        </p>
      </GroupBox>

      <GroupBox title="Made by">
        <p className="m-0 max-w-[75ch]">Wetcast was designed and built by Aman Singh Aswal.</p>
        <dl className="m-0 mt-2 grid max-w-[75ch] grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
          <dt className="font-bold">Source code</dt>
          <dd className="m-0">
            <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
              {SOURCE_URL.replace('https://', '')}
            </a>{' '}
            on Codeberg
          </dd>
          <dt className="font-bold">GitHub</dt>
          <dd className="m-0">
            <a href="https://github.com/amanaswal9" target="_blank" rel="noopener noreferrer">
              github.com/amanaswal9
            </a>
          </dd>
          <dt className="font-bold">LinkedIn</dt>
          <dd className="m-0">
            <a href="https://www.linkedin.com/in/amannaswal/" target="_blank" rel="noopener noreferrer">
              linkedin.com/in/amannaswal
            </a>
          </dd>
        </dl>
      </GroupBox>
    </div>
  )
}
