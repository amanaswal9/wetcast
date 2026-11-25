# Wetcast

Intelligent spatial-temporal weather forecasting, with a classic 1990s desktop interface.

Try it: https://amanaswal9.github.io/wetcast/ (the public copy, free on GitHub Pages). It shows the live weather
from Open-Meteo (the Dashboard, the 7-day forecast, the map, search and Wetcast Mini) and the forecasts of Wetcast's
own trained models for their 48 cities, refreshed every 3 hours, with the models' test results. The live track
record, official warnings, saved places on the server and the Javed assistant need the server and run on the full
setup below; the demo shows them.

![Wetcast demo: the Dashboard for Delhi with its LCD readout, searching Jaipur, opening the Forecast from the Start menu, Wetcast's model forecasts next to Open-Meteo, the weather map's temperature and wind tools, the test-period results, and switching to Fahrenheit in the Units dialog](docs/demo/wetcast-demo.gif)

A 53-second tour recorded from the running app with live data ([MP4, 1280×720](docs/demo/wetcast-demo.mp4)).
Only the title card, captions and pointer are drawn on top. Re-record it with `docs/demo/record_demo.py`
(needs the dev servers, Playwright with Chromium, and ffmpeg).

- Dashboard: current conditions, readings, air quality, sun, hourly chart and table, read-aloud summary.
- Wetcast Mini (`/mini/`, Start menu): a small widget-style window with the weather now, the next four hours and,
  on tall screens, three days. It installs on its own (Chrome or Edge install button, Safari Add to Dock on a Mac,
  Add to Home Screen on iPhone and Android). The About page has the steps for each device.
- Desktop picture (optional, this computer only): an ASCII picture behind the window, made with
  `docs/share/make_wallpaper_ascii.py` into the git-ignored `src/local/`; without it the desktop is plain.
- Official warnings (top of the Dashboard): alerts in effect at the place from India's NDMA Sachet portal
  (IMD and state authorities) or the US National Weather Service, shown exactly as issued.
- Ask (optional: an open model running locally through Ollama): Javed, a weather assistant that answers questions using
  only data it looks up (Open-Meteo, Wetcast's models, official warnings), with its sources under each answer.
- Map: temperature, rain and wind over a map for the next 48 hours, from Open-Meteo forecasts at a grid of
  points, with the cities Wetcast's own models cover marked.
- Forecast: 7-day strip and per-day detail, plus Wetcast's own predictions (LSTM, GRU, CNN-LSTM,
  ST-Transformer, LightGBM and their ensemble)
  for the next 24 hours with error ranges, side by side with Open-Meteo's forecast.
- Analytics: actual vs predicted on the held-out test period, error by city, and historical trends for any place.
- Models: test-set MAE, RMSE and R², a persistence baseline, error-range coverage, the live track record and
  inference time. All numbers come from the `metrics.json` file in each folder of `ml/artifacts/`.
- Locations: up to 8 saved places, a home location, and a 2 to 4 city comparison.

- About: the project in plain words, how the forecasts are made, how to read the charts, data sources
  and licences, known limits, and the technology used. Its results line is read live from the API.

### Saved places

Saved places and the home location are stored in PostgreSQL (`saved_places`) under an anonymous random ID
created in each browser (`X-Client-Id`); there are no accounts. The browser keeps a copy so the app opens
instantly and keeps working when the API is down (`src/hooks/useSavedPlaces.ts`):

- On load the server's list wins, unless the browser has unsent changes or this is the first sync and the
  server is empty, in which case the browser's list is uploaded (this migrated places saved before the server existed).
- Each change is applied locally at once and sent as a full replacement (`PUT /api/places`). Sends run one at a
  time and always carry the latest state.
- If the API is unreachable the Locations page says "Saved in this browser only" and the change is sent on the
  next change, the next load, or when the browser comes back online. Conflicts between tabs are last-write-wins.

## Layout

```
src/            Preact (React code via preact/compat) + TypeScript + Vite frontend (retro UI kit in src/components/retro)
backend/app/    FastAPI API: settings, database, model registry, live predictions
backend/tests/  API tests (pytest)
ml/weatherai_ml Training pipeline AND the shared preprocessing the API uses at inference
ml/tests/       Pipeline, leakage and prediction tests (pytest)
e2e/            Browser journeys, screenshots and accessibility (pytest + Playwright, recorded network)
scripts/        check-bundle.mjs: bundle-size budget
ci/lighthouse/  Lighthouse CI settings and its own packages
ml/artifacts/   Trained models: model.keras, preprocessor.json, metrics.json, evaluation.json
deploy/ (web Dockerfile, nginx), docker-compose.yml, backend/Dockerfile   Container deployment
```

## Browser and device support

The site is a responsive web app, so it runs in the browser on Windows, macOS, Linux, iPhone, iPad and Android.

| Browser | Minimum |
| --- | --- |
| Safari (macOS, iPhone, iPad) | 16.4 (iOS / iPadOS 16.4, March 2023) |
| Chrome, Edge (Windows, macOS, Android) | 111 |
| Firefox | 128 |

These are Tailwind CSS v4's requirements and are set as the build target. Older browsers see a plain
"please update your browser" message instead of a blank page.

Tested layouts: 320 px (small phones), 375 px (phones), 768 px (tablets) and desktop, with no sideways scrolling.
On touch screens buttons grow to 40 px and text fields use 16 px text so iOS doesn't zoom in when you type.
The interface font is Noto Sans, shipped with the app, so text looks the same on every system. Read aloud uses the browser's speech engine, which is
available in current Chrome, Edge, Safari and Firefox; the button is hidden where it isn't.

Voice search (the microphone next to the city search) uses the browser's speech recognition: Chrome, Edge and
Safari support it; Firefox doesn't, so the button is hidden there. It needs https or localhost and microphone
permission. Phrases like "weather in Jaipur", "will it rain in Mumbai this week" or "open the models page" are
parsed by fixed rules in `src/lib/voice.ts` (tested in `voice.test.ts`); if the top search result matches the
spoken city exactly, it opens directly and says which place it chose. Chrome and Edge process the audio on their
makers' servers and Safari on Apple's; Wetcast only receives the recognised words.

To open the development server from a phone on the same Wi-Fi, run `npm run dev -- --host` and visit the
address Vite prints (Windows may ask to allow Node through the firewall). For real use, deploy it (see Deployment).

## Run it locally

Requirements: Node.js 20+, Python 3.11+, PostgreSQL 15+. Works on Windows, macOS and Linux. The commands
below use the Windows virtual-environment path `Scripts/`; on macOS and Linux use `bin/` instead
(for example `~/.venvs/weatherai/bin/python`). On Apple-silicon Macs TensorFlow runs on the CPU, as it does here.

```bash
# 1. Python environment (keep the path short on Windows: TensorFlow's DLLs fail on long paths)
python -m venv ~/.venvs/weatherai
~/.venvs/weatherai/Scripts/python -m pip install -r backend/requirements.txt pytest scikit-learn pyarrow
~/.venvs/weatherai/Scripts/python -m pip install -e ml

# 2. Database: create a role and database, then copy backend/.env.example to backend/.env and fill it in
#    CREATE ROLE weatherai LOGIN PASSWORD '...'; CREATE DATABASE weatherai OWNER weatherai;

# 3. API (applies database migrations on startup)
cd backend
~/.venvs/weatherai/Scripts/python -m uvicorn app.main:app --port 8000

# 4. Frontend (another terminal, repository root). Vite forwards /api to :8000.
npm install
npm run dev        # http://localhost:5173
```

Without the backend running, the Dashboard, Forecast, Locations and historical trends still work; the model
panels say the prediction service isn't reachable.

### Database migrations

The schema is managed with Alembic (`backend/alembic/`, settings in `backend/alembic.ini`; the database URL
always comes from `WEATHERAI_DATABASE_URL`). The API upgrades the database to the latest migration when it
starts. A database created by an older version (tables but no migration record) is recorded as the baseline
`0001` without touching its data; one with only some of the tables is refused with a message.

```bash
cd backend
~/.venvs/weatherai/Scripts/python -m alembic current                                   # revision in use
~/.venvs/weatherai/Scripts/python -m alembic revision --autogenerate -m "describe change"  # after editing app/db.py
~/.venvs/weatherai/Scripts/python -m alembic upgrade head                               # apply without starting the API
```

Read every generated migration before committing it. `tests/test_migrations.py` fails if `app/db.py` and the
migrations disagree.

### Tests

```bash
cd ml && ~/.venvs/weatherai/Scripts/python -m pytest tests          # pipeline, leakage, predictor
cd backend && ~/.venvs/weatherai/Scripts/python -m pytest tests     # API (offline; uses SQLite and synthetic inputs)
npm test                                                             # frontend unit tests (Vitest)
npm run build && npm run lint                                        # frontend type-check, build, lint
npm run size                                                         # bundle-size budget (after build)
~/.venvs/weatherai/Scripts/python -m pytest e2e                     # browser journeys + accessibility (after build)
cd ci/lighthouse && npm ci && npx lhci autorun                       # Lighthouse scores (after build, about 3 minutes)
```

The browser tests open the production build in Chromium with every network call answered from
`e2e/fixtures/`, so they are offline and repeatable. They check key journeys (Dashboard, city search, Start
menu by keyboard, Forecast days, units, map tools, "Not found"), compare screenshots with references in
`e2e/screenshots/<platform>/`, and run axe-core (WCAG 2.2 A/AA) on every page in both themes. `E2E_RECORD=1`
records responses not saved yet (needs internet and the API); `E2E_UPDATE=1` replaces the reference
screenshots after an intended visual change.

### Continuous integration

`.github/workflows/ci.yml` runs on GitHub Actions (free for public repositories) on every push and pull request: a frontend job (`npm ci`, lint, Vitest, type-check, build and the bundle-size budget), a browser job (the
`e2e` tests, compared with the Linux reference screenshots in `e2e/screenshots/linux/`, then Lighthouse on four pages with
the limits in `ci/lighthouse/lighthouserc.js`; its reports are kept as the `lighthouse-reports` artifact) and a Python job (ML pipeline and API tests on
Python 3.13 with CPU TensorFlow). The jobs run in the same Debian images as the reference screenshots
(`node:22-bookworm`, `python:3.13-bookworm`). It needs no secrets.

`.github/workflows/publish.yml` publishes the public copy to GitHub Pages (https://amanaswal9.github.io/wetcast/)
after CI passes on `main`, and every 3 hours on its own. It builds from the clean checkout with `VITE_PUBLIC_SITE`
set to that address (every file under `/wetcast/`, the link preview's full address, no calls to the Wetcast
server: `src/lib/site.ts`) and `VITE_PUBLIC_DATA=1`. Then `backend/scripts/export_public_data.py` runs the models for
all 48 cities with live Open-Meteo data, asking the API's own endpoints in-process (no server, no database), and
writes the answers as plain files under `dist/data/`, which the site reads in place of the server: the latest
forecast per city, the models' test scores and their evaluations. `scripts/pages-meta.mjs` puts the
Content-Security-Policy and Referrer-Policy from `deploy/security-headers.conf` into the pages as `<meta>` tags;
GitHub Pages can't send custom headers, so X-Frame-Options, Permissions-Policy and the CSP's `frame-ancestors` only
apply on the self-hosted setup. The job's own token publishes the site; no secret is needed. GitHub pauses
scheduled runs after 60 days without a push; "Enable workflow" on the Actions tab restarts them.

To try the public build locally: `VITE_PUBLIC_SITE=http://localhost:4173/wetcast/ VITE_PUBLIC_DATA=1 npm run build`,
then from `backend/` run `python -m scripts.export_public_data ../dist/data`, then `npx vite preview --base /wetcast/`.

The API tests replace the Open-Meteo call with clearly labelled synthetic data (`weatherai_ml/synthetic.py`),
so they are offline and deterministic. Synthetic data is never used for training, evaluation or the app.

## The models

| | |
| --- | --- |
| Region | India: trained on 40 cities (state and territory capitals and North India), tested on 8 more held out from training |
| Data | Open-Meteo Historical Forecast API, hourly, 2023-01-01 to 2026-10-31 |
| Spatial context | Each city plus four points about 55 km north, south, east and west |
| Input | Last 48 hours × 42 features (7 weather variables × 5 points, time of day, season, latitude, longitude, elevation) |
| Output | Next 24 hours of temperature, humidity and rain at the city |
| Architectures | Two-layer LSTM, two-layer GRU, causal CNN + LSTM, a spatio-temporal Transformer (`ml/weatherai_ml/models.py`), LightGBM gradient-boosted trees (`ml/weatherai_ml/gbm.py`), and an equal-weight ensemble (`ml/weatherai_ml/ensemble.py`) |

LightGBM turns each forecast into 24 table rows (one per hour ahead) built from the current features, the
city's last 24 hours (lags 1, 3, 6, 12, 24) and the value 24 hours before each predicted hour, predicting the
day-on-day change like the version 2 networks. One booster per target, early-stopped on the validation year.
It has the best single-model humidity (test MAE 5.95 %), runs a forecast in about 2 ms, and its feature
importance is shown on the Models page; its rain MAE is weaker than the networks'.

The ST-Transformer (spatio-temporal Transformer, 150k parameters) cuts each of the five points' 48 hours
into 6-hour patches, giving 40 tokens (5 points × 8 patches). Each token carries that point's weather for those
hours plus the time and location features; learned position embeddings say which point and which patch it is.
Two pre-norm Transformer blocks (4-head self-attention, width 64) attend across all tokens at once, so the
model relates any point at any time to any other: with five points this is attention over a fully connected
spatial graph, learned jointly with time. The head reads the city's own 8 tokens. Targets, loss and training
are the same as the recurrent networks.

Four variants were compared on the validation year only (`ml/experiments/e6`–`e9`): the base settings won
(validation temperature MAE 0.983 °C, against 0.998–1.018 for 4-hour patches, 3 blocks or width 96, and 1.001
for LightGBM). Scored once on the 2026 test period it is the best single model for temperature (1.141 °C, just
ahead of LightGBM's 1.153) and rain (0.114 mm), and second for humidity (6.18 %); its validation lead over
LightGBM mostly shrank on the test period, so treat the two as close. It forecasts in about 45 ms.

The ensemble averages member predictions with equal weights. Its members are chosen on the validation year
between candidate sets fixed in advance: the three recurrent networks, plus each combination of the later
additions (LightGBM; the ST-Transformer, added before its test results were seen). All five won on validation
and give the best test temperature MAE, 1.118 °C (it was 1.132 °C without the Transformer), with humidity
5.97 % and rain 0.118 mm. It takes about 640 ms per forecast on the CPU.

Rebuild both after training the networks:

```bash
~/.venvs/weatherai/Scripts/python -m weatherai_ml.gbm
~/.venvs/weatherai/Scripts/python -m weatherai_ml.ensemble
```

Retrain with:

```bash
cd ml
~/.venvs/weatherai/Scripts/python -m weatherai_ml.fetch     # ~20 min: waits between cities for the free rate limit
~/.venvs/weatherai/Scripts/python -m weatherai_ml.train --models lstm gru cnn_lstm transformer --target-mode residual24 --lookback 48 --train-stride 4 --loss huber
```

### Model selection (version 2)

Version 1 predicted each value directly and barely beat persistence on temperature. Version 2 predicts, for
temperature and humidity, the change from the same hour the day before and adds it back (rain stays
direct), and uses a Huber loss. Settings were chosen with `--experiment` runs that score only the 2025
validation year; the 2026 test set was evaluated once, after the choice was fixed. Results are in
the JSON files in `ml/experiments/`; version 1 test metrics are kept in `ml/experiments/v1_artifacts/`.

| Validation 2025, CNN-LSTM | Temp MAE °C | Humidity MAE % | Rain MAE mm |
| --- | --- | --- | --- |
| Direct, 48 h (version 1) | 1.208 | 6.075 | 0.1271 |
| Residual, 48 h | 1.053 | 5.899 | 0.1275 |
| Residual, 72 h | 1.066 | 5.935 | 0.1294 |
| Residual, 72 h, sample every 2 h | 1.075 | 5.912 | 0.1346 |
| Residual, 72 h, every 2 h, Huber | 1.052 | 5.880 | 0.1108 |
| Residual, 48 h, Huber (chosen) | 1.051 | 5.814 | 0.1096 |
| Persistence baseline | 1.203 | 6.625 | – |

Test period (Jan–Oct 2026), evaluated once after the choice. Version 1 → version 2, MAE:

| Model | Temperature °C | Humidity % | Rain mm |
| --- | --- | --- | --- |
| LSTM | 1.326 → 1.224 | 6.446 → 6.630 | 0.125 → 0.118 |
| GRU | 1.305 → 1.178 | 6.220 → 6.372 | 0.128 → 0.116 |
| CNN-LSTM | 1.374 → 1.196 | 6.431 → 6.449 | 0.129 → 0.117 |
| Persistence | 1.383 | 7.592 | 0.183 |

The result is mixed and reported as measured: temperature improved for every model (8–13% lower MAE), but humidity got slightly worse on the test year although it improved on validation,
and rain's typical error fell while its RMSE and R² got worse (Huber loss trades big-storm accuracy for typical
hours). Tuning further against these test numbers would leak the test set into model selection, so it wasn't done.

### All-India model (in progress)

A second region, `india`, covers every state and union territory: 40 training cities (each capital, or the
nearest large city to a new capital, plus the original ten) and 8 held-out cities that are never trained on
(Aurangabad, Nagpur, Coimbatore, Visakhapatnam, Jodhpur, Indore, Gorakhpur, Mangaluru), each at least 150 km from
every training city. The list is built from Open-Meteo geocoding by `weatherai_ml/build_india_cities.py` and stored
in `weatherai_ml/regions/india.json`.

Held-out cities are excluded from scaler fitting, training and validation; they are scored only on the test period,
which gives an honest accuracy figure for places the model has never seen. Because each sample carries latitude,
longitude, elevation and neighbouring points, the model can then be run for any location in India.

```bash
cd ml
~/.venvs/weatherai/Scripts/python -m weatherai_ml.fetch --region india     # ~2 days on the free API tier; resumable
~/.venvs/weatherai/Scripts/python -m weatherai_ml.train --region india --target-mode residual24 --lookback 48 --train-stride 4 --loss huber
```

The download waits out Open-Meteo's per-minute, hourly and daily limits on its own and skips cities already saved,
so it can be stopped and restarted at any time. Artifacts go to `ml/artifacts/india/`, which the API serves
(`WEATHERAI_ARTIFACTS_DIR`); the earlier North India models stay in `ml/artifacts/`. `ml/train_india.ps1` runs the
whole training job (about 4 hours on an ordinary CPU).

### How leakage is prevented

- Chronological split: train 2023–2024, validation 2025, test Jan–Oct 2026. No shuffling across time.
- Whole windows only: a sample counts only if all 48 input hours and all 24 target hours fall inside one split
  and one city, so nothing straddles a boundary (`dataset.window_ends`, covered by tests).
- Scaler fitted on training rows only (`preprocess.Preprocessor.fit`), then saved with the model.
- Same pipeline at inference: the API calls the same `features.build_frames` and loads the saved
  `preprocessor.json`, which refuses to run if the feature columns or their order differ.
- No silent gap filling: gaps of up to 3 hours are interpolated; longer gaps make the window invalid.

### Honest evaluation

- Every metric is on the 2026 test period, which training never saw.
- A persistence baseline (same hour yesterday) is reported next to every model.
- Error ranges use split conformal prediction calibrated on the validation year, with separate ranges for
  each calendar month because errors change with the season (wider in spring). The Models page shows how often
  test values actually fell inside them, at the training and the held-out cities.
  `python -m weatherai_ml.recalibrate --region india` recomputes them for saved models without retraining.
- Chance of rain: the models' rain amounts run low, so the Ensemble also gives the chance of at least 0.1 mm
  in each hour, calibrated on the validation year (`python -m weatherai_ml.rain_chance --region india`, after
  `recalibrate`). Since 2026-11-21 a small LightGBM classifier gives it, taking Open-Meteo's own forecast for the
  hour (made about a day earlier, from the free Previous Runs API) as one more input
  (`python -m weatherai_ml.outlook --region india` downloads those forecasts, then
  `python -m weatherai_ml.chance_model --region india`). On the test period its Brier score is 0.097 (0.107 from
  the models alone, 0.104 when the forecast can't be fetched), against 0.174 for always forecasting the usual
  rain frequency; the Models page shows how often it rained when it said 20%, 50% and so on.
- Rain amounts: the Ensemble's are corrected to the expected amount by a small LightGBM model fitted on the
  validation year (`python -m weatherai_ml.rain_amount --region india`, after `rain_chance`). On the test period
  R² rose from 0.114 to 0.183 and RMSE fell from 0.755 to 0.725 mm; mean absolute error rose from 0.177 to 0.211 mm,
  because that measure rewards forecasting almost no rain. Open-Meteo's forecast as an input added too little here
  to keep (`--outlook` turns it on). LightGBM's own rain model learns with a Tweedie loss
  (`python -m weatherai_ml.gbm --region india --only precipitation`).
- NASA satellite rain check (2026-11-23): `python -m weatherai_ml.imerg --region india` downloads GPM IMERG
  Late Run rain at the 48 cities for 2023 to October 2026 (free; needs a NASA Earthdata token), and
  `python -m weatherai_ml.imerg_check` tests it. As an input to the rain correction it did not help, even
  without its 14-hour delay, so the app does not use it. As an independent judge on the 2026 test period, the
  Ensemble's rain matches the satellite better (correlation 0.29) than Open-Meteo's own day-old forecast (0.22).
- Where the models predict: anywhere in India within 310 km of a training city (the farthest a held-out
  city lies from one). Each forecast says whether the place is a training city, a held-out city or an untrained
  location, with the error measured for that kind of place. Elsewhere the API answers `unsupported_location`.
- Held-out cities (Aurangabad, Nagpur, Coimbatore, Visakhapatnam, Jodhpur, Indore, Gorakhpur, Mangaluru)
  never touch training, scaling or validation, and are each at least 150 km from every training city.
- Training targets are Open-Meteo model data, not observations; live inputs come from the same model family.
- A live track record keeps scoring the models after training (below).

### Live track record

A background job in the API (`backend/app/track_record.py`) runs every 3 hours, aligned to UTC hours. For each
of the 48 cities it fetches the last 72 hours (one Open-Meteo request), issues and stores a 24-hour forecast
from every model, saves the city centre's past hours as observations, and scores every stored forecast whose
hour has passed. Forecasts people open for those cities on the Forecast page are stored and scored the same
way; forecasts for other points are not kept. Each stored forecast records which model set made it.

- What happened is Open-Meteo's record of past hours at the city centre: the same kind of data the models
  were trained and tested on, not a weather-station reading. An hour is saved only once it is 6 hours old,
  so newer model runs no longer change it, and it is never overwritten.
- Baseline: each scored value also stores persistence (the same hour a day earlier), so models and the
  baseline are compared on exactly the same hours. The share of values inside the 80% range is reported too.
- A forecast can be scored about 30 hours after it is issued. Older unscored forecasts (up to 90 days) are
  backfilled with one centre-only request.
- The Models page shows the record for the last 7, 30 or 90 days next to the test-period figures, with a
  warning while it covers less than a week.
- Cost: about 80 Open-Meteo calls a day (10 cities × 8 cycles), out of the free tier's 10,000. If a limit is
  hit, that cycle fails quickly for the affected cities and the next cycle catches up.
- Run one cycle by hand: `cd backend && python -m app.track_record`. Turn the job off with
  `WEATHERAI_TRACK_RECORD_INTERVAL_HOURS=0`. Run the API with one worker, or the job runs once per worker.

## API

| Method and path | Purpose |
| --- | --- |
| `GET /api/health` | Database status and available models |
| `GET /api/coverage` | Cities the models cover |
| `GET /api/models`, `/api/models/{name}` | Metrics from the evaluation run |
| `GET /api/models/{name}/evaluation?city=&include_samples=` | Per-horizon and per-city errors, actual-vs-predicted samples |
| `GET /api/predictions?latitude=&longitude=&models=` | Live 24-hour predictions with error ranges; stored in PostgreSQL |
| `GET /api/assistant/status`, `POST /api/assistant` | Whether the assistant is switched on; ask it a question (needs `X-Client-Id`; daily limits apply) |
| `GET /api/alerts?latitude=&longitude=&country=` | Official warnings in effect at a point: India from the stored Sachet feed, the US from the National Weather Service, otherwise a note that no feed is connected |
| `GET /api/track-record?days=&city=` | Live track record: errors of stored forecasts once their hours have passed, per model, day and hours ahead, with persistence on the same hours |
| `GET/POST/PUT /api/places`, `PUT/DELETE /api/places/{id}/home`, `DELETE /api/places/{id}` | Saved places per `X-Client-Id` (`PUT` replaces the whole list) |

Interactive docs: http://localhost:8000/docs.

## Configuration

All settings come from environment variables with the `WEATHERAI_` prefix (see `backend/.env.example`).
Secrets live only in `backend/.env`, which is git-ignored. Open-Meteo needs no API key.

## Deployment

`docker compose up --build` runs PostgreSQL, the API and the nginx-served frontend on http://localhost:8080.
The fully open-source way is Docker Engine (Linux) or Podman: `podman compose up --build` works with the same files.
nginx sends strict security headers (`deploy/security-headers.conf`): a content security policy that allows only the
app's own scripts and Open-Meteo and OpenStreetMap as outside sources, no framing, no MIME sniffing, a limited
referrer, and location and microphone for this site only. It also rate-limits the API per visitor address (10 requests a
second with bursts of 30; the assistant 1 a second with bursts of 3), answering 429 beyond that, and refuses request
bodies over 64 KB.
Set `POSTGRES_PASSWORD` in a `.env` next to `docker-compose.yml`, and `WEB_PORT` if port 8080 is taken on your
computer. Tested 2026-11-23 with Docker Desktop on Windows: all three containers start, the API loads the six models
and serves predictions, and the site works.

## Weather map

The Map page (`src/features/map/MapPage.tsx`, grid logic in `src/lib/api/mapGrid.ts`) shows Open-Meteo's forecast
for the next 48 hours at evenly spaced points over the visible area, as coloured squares (temperature, rain) or
arrows pointing where the wind blows. Values between points are not interpolated, and the page says so.

- Grid: spacing is chosen per axis from 0.1° to 20° so squares stay at least 40 px on screen, with at most
  160 points. Points sit on multiples of the spacing, so panning reuses points already fetched (cached 30 minutes).
- Free-tier limits: Open-Meteo counts each point as one call (600 a minute per visitor). The map keeps itself
  to 400 points in any rolling minute and shows a short wait instead of going over; a limit hit anyway is
  explained in plain words.
- Base map: OpenStreetMap's standard tiles through Leaflet, shown in greyscale (inverted for high contrast).
  They need no key; OpenStreetMap's tile policy allows light use with attribution. A busy public deployment should
  switch to a tile provider sized for it. (CARTO's basemaps were tried first, but they now require an API key.)
- The scroll wheel zooms only after the map is clicked or focused, so the page scrolls past it normally.

## Weather assistant (optional)

The Ask page's assistant, Javed, runs on a small open model (default `qwen3:4b-instruct`, Apache 2.0, about
2.5 GB) through [Ollama](https://ollama.com/) (MIT) on the same computer as the API
(`backend/app/assistant_local.py`). Nothing is billed and questions don't leave the machine; only the tools' own
lookups do. A small model is slower and makes more mistakes than a large one, and the Ask page says so. Without
Ollama the Ask page simply says the assistant isn't switched on; everything else works.

How it answers (`backend/app/assistant.py`, data tools in `backend/app/assistant_data.py`):

- Five read-only tools: `find_place`, `get_weather` (Open-Meteo: now, next 48 hours, 7 days),
  `get_weatherai_prediction` (Wetcast's ensemble with 80% ranges, covered cities only), `get_official_alerts`
  (NDMA Sachet / US NWS) and `get_model_accuracy` (test results and the live track record).
- The instructions tell it to answer only from what the tools return, to say when data isn't available, to name
  the source of every number, to give ranges rather than certainties, to repeat official warnings as issued and
  point people to their weather service for safety questions, and to stay on weather. Replies are cleaned to
  plain text.
- At most 5 model calls per answer. If it gives numbers without any lookup, it is sent back once to look first.
- The page sends the last 10 turns with each question; the server keeps no chat history.

Switch it on:

1. Install Ollama: `winget install Ollama.Ollama` (it starts with Windows and listens on `127.0.0.1:11434`).
2. Download the model once: `ollama pull qwen3:4b-instruct`.
3. That's all: `GET /api/assistant/status` reports `configured: true, provider: "local"` within 30 seconds.

Settings (all optional, in `backend/.env`):

| Setting | Default | Meaning |
| --- | --- | --- |
| `WEATHERAI_ASSISTANT_PROVIDER` | `auto` | `auto` or `local` (use Ollama when it is running) or `off` |
| `WEATHERAI_OLLAMA_URL` | `http://127.0.0.1:11434` | Where Ollama listens |
| `WEATHERAI_OLLAMA_MODEL` | `qwen3:4b-instruct` | Any installed Ollama model that supports tool calling (use an instruct, non-thinking edition) |
| `WEATHERAI_OLLAMA_CONTEXT` | `4096` | Context window in tokens; larger needs more graphics memory |
| `WEATHERAI_ASSISTANT_DAILY_LIMIT_PER_CLIENT` | `20` | Questions per visitor (anonymous browser id) per UTC day |
| `WEATHERAI_ASSISTANT_DAILY_LIMIT_TOTAL` | `200` | Questions for the whole server per UTC day |

The daily counts are kept in the database (table `assistant_usage`), so restarting the API doesn't reset them.
Tests (`backend/tests/test_assistant.py`, `test_assistant_local.py`) replace Ollama with a scripted fake and never
call it.

## Official warnings

Free sources checked for item 9 (2026-11-20):

| Source | Coverage | Access | Used |
| --- | --- | --- | --- |
| NDMA Sachet all-India CAP feed (`sachet.ndma.gov.in/cap_public_website/rss/rss_india.xml`) | India: IMD regional centres and state disaster authorities, with district polygons | Public RSS of CAP 1.2 messages, no key, marked public domain; no CORS, so the API reads it | Yes |
| IMD's own API (`api.imd.gov.in`) | India: district warnings and nowcasts | Needs the caller's IP to be whitelisted by IMD on request | No (Sachet carries IMD's alerts) |
| US National Weather Service (`api.weather.gov/alerts/active?point=`) | United States | Free, no key, point query | Yes, live with a 5-minute cache |
| WMO Alert Hub, MeteoAlarm and other national CAP feeds | Many countries | Free feeds of varying format and coverage | Not yet |

How it works (`backend/app/alerts.py`):

- A job in the API reads the Sachet feed every 10 minutes (`WEATHERAI_ALERTS_POLL_MINUTES`; 0 turns it off),
  fetches each new CAP message and its area polygon once, and keeps it until a week after it expires. The feed
  lists only its latest 100 messages (one to five days' worth), so storing them keeps active warnings that have
  scrolled off it. Updates and cancellations retire the messages they refer to; tests and exercises are ignored.
- `GET /api/alerts` returns the warnings whose polygon contains the point (ray casting after a bounding-box
  filter), worst first, and says when the feed hasn't been read for three polling intervals.
- XML is parsed with `defusedxml`. Requests identify the app with a generic client name.
- The Dashboard shows warnings in a message box with the issuer, area, validity and source. With none it shows
  one line, and for India it adds that the feed isn't a complete archive. Elsewhere it says plainly that no
  official feed is connected for that country.

## Data sources and labelling

| What you see | Source | Label in the UI |
| --- | --- | --- |
| Current conditions, past hours | Open-Meteo forecast models | "Open-Meteo model estimate" / solid line |
| Forecast | Open-Meteo forecast | "Open-Meteo forecast" / dashed line |
| Wetcast predictions | Our LSTM, GRU, CNN-LSTM, ST-Transformer, LightGBM, ensemble | Model colour, dithered error range |
| Historical trends | Open-Meteo archive (ERA5) | Named under the chart |
| Official warnings | NDMA Sachet (India), US National Weather Service | Source named under the warnings |
| Weather map | Open-Meteo forecast at grid points, on OpenStreetMap tiles | "About this map" box under the map |
| Map outlines | Natural Earth 1:50m countries (public domain) | Listed on the About page |

Every build also writes `third-party-licences.txt` next to `index.html`: the licence text of every open-source package
and font the site includes (minifying removes their notices from the code itself). The About page links to it, and
the build stops if a bundled package has no licence file to pass on (`thirdPartyLicences` in `vite.config.ts`).

## Design system

- Colours are CSS variables in `src/index.css` (light, dark and high contrast; the first visit follows the device setting). Chart colours are mirrored in
  `src/lib/chartTheme.ts` because SVG attributes can't read CSS variables.
- Fonts, all under the SIL Open Font License and shipped with the app (no font CDN): Noto Sans for the interface,
  Noto Sans Mono for the desktop picture, Pixelify Sans for big numbers, VT323 for terminal text.
- Accessibility: Radix Tabs, an ARIA combobox for search, dotted focus rectangles, table alternatives,
  and reduced motion through Motion's `MotionConfig`.

## Author

Designed and built by Aman Singh Aswal.

- Source code: https://github.com/amanaswal9/wetcast
- GitHub: https://github.com/amanaswal9
- LinkedIn: https://www.linkedin.com/in/amannaswal/

## Licence

Wetcast is free software, released under the GNU Affero General Public License, version 3 or later
(AGPL-3.0-or-later); the full text is in `LICENSE`. You may use, study, share and change it. If you run a changed
version as a website, the licence asks you to offer your visitors its source too (the About page links to this
repository for that reason).

Everything it depends on is open as well:

- Code libraries: MIT, BSD, Apache-2.0, MPL-2.0, ISC and LGPL-3.0 (psycopg), all open-source licences.
- Fonts: Noto Sans, Noto Sans Mono, Pixelify Sans and VT323, SIL Open Font License, shipped with the app.
- Javed: Ollama (MIT) running Qwen3 4B Instruct (Apache-2.0) on the server's own computer.
- Data: Open-Meteo (CC BY 4.0; its server is open source too), OpenStreetMap (ODbL), NDMA Sachet and the US
  National Weather Service (public domain), Natural Earth outlines (public domain), NASA IMERG (open, used only
  for a one-off check).
- No paid services, no trackers, no advertising. Voice search uses the browser's own speech recognition, which in
  Chrome and Edge sends the audio to Google's or Microsoft's speech service; Wetcast never receives the audio.

Copyright (C) 2026 Aman Singh Aswal.
