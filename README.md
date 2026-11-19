# WeatherAI

Intelligent spatial-temporal weather forecasting, with a classic 1990s desktop interface.

- **Dashboard**: current conditions, readings, air quality, sun, hourly chart and table, read-aloud summary.
- **Forecast**: 7-day strip and per-day detail, plus WeatherAI's own LSTM, GRU and CNN-LSTM predictions
  for the next 24 hours with error ranges, side by side with Open-Meteo's forecast.
- **Analytics**: actual vs predicted on the held-out test period, error by city, and historical trends for any place.
- **Models**: test-set MAE, RMSE and R², a persistence baseline, error-range coverage, a check against real
  weather stations, and inference time. All numbers come from `ml/artifacts/*/metrics.json`.
- **Locations**: up to 8 saved places, a home location, and a 2 to 4 city comparison.

- **About**: the project in plain words, how the forecasts are made, how to read the charts, data sources
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
src/            React + TypeScript + Vite frontend (retro UI kit in src/components/retro)
backend/app/    FastAPI API: settings, database, model registry, live predictions
backend/tests/  API tests (pytest)
ml/weatherai_ml Training pipeline AND the shared preprocessing the API uses at inference
ml/tests/       Pipeline, leakage and prediction tests (pytest)
ml/artifacts/   Trained models: model.keras, preprocessor.json, metrics.json, evaluation.json
deploy/, docker-compose.yml, backend/Dockerfile, Dockerfile.web   Container deployment
```

## Run it locally

Requirements: Node.js 20+, Python 3.11+, PostgreSQL 15+.

```bash
# 1. Python environment (keep the path short on Windows: TensorFlow's DLLs fail on long paths)
python -m venv ~/.venvs/weatherai
~/.venvs/weatherai/Scripts/python -m pip install -r backend/requirements.txt pytest meteostat scikit-learn pyarrow
~/.venvs/weatherai/Scripts/python -m pip install -e ml

# 2. Database: create a role and database, then copy backend/.env.example to backend/.env and fill it in
#    CREATE ROLE weatherai LOGIN PASSWORD '...'; CREATE DATABASE weatherai OWNER weatherai;

# 3. API (tables are created on startup)
cd backend
~/.venvs/weatherai/Scripts/python -m uvicorn app.main:app --port 8000

# 4. Frontend (another terminal, repository root). Vite forwards /api to :8000.
npm install
npm run dev        # http://localhost:5173
```

Without the backend running, the Dashboard, Forecast, Locations and historical trends still work; the model
panels say the prediction service isn't reachable.

### Tests

```bash
cd ml && ~/.venvs/weatherai/Scripts/python -m pytest tests          # pipeline, leakage, predictor
cd backend && ~/.venvs/weatherai/Scripts/python -m pytest tests     # API (offline; uses SQLite and synthetic inputs)
npm run build && npm run lint                                        # frontend type-check, build, lint
```

The API tests replace the Open-Meteo call with clearly labelled synthetic data (`weatherai_ml/synthetic.py`),
so they are offline and deterministic. Synthetic data is never used for training, evaluation or the app.

## The models

| | |
| --- | --- |
| Region | North India: Delhi, Jaipur, Lucknow, Chandigarh, Agra, Dehradun, Kanpur, Amritsar, Bikaner, Varanasi |
| Data | Open-Meteo Historical Forecast API, hourly, 2023-01-01 to 2026-10-31 |
| Spatial context | Each city plus four points about 55 km north, south, east and west |
| Input | Last 48 hours × 42 features (7 weather variables × 5 points, time of day, season, latitude, longitude, elevation) |
| Output | Next 24 hours of temperature, humidity and rain at the city |
| Architectures | Two-layer LSTM, two-layer GRU, causal CNN + LSTM (`ml/weatherai_ml/models.py`) |

Retrain with:

```bash
cd ml
~/.venvs/weatherai/Scripts/python -m weatherai_ml.fetch     # ~20 min: waits between cities for the free rate limit
~/.venvs/weatherai/Scripts/python -m weatherai_ml.train --target-mode residual24 --lookback 48 --train-stride 4 --loss huber
```

### Model selection (version 2)

Version 1 predicted each value directly and barely beat persistence on temperature. Version 2 predicts, for
temperature and humidity, the **change from the same hour the day before** and adds it back (rain stays
direct), and uses a Huber loss. Settings were chosen with `--experiment` runs that score **only the 2025
validation year**; the 2026 test set was evaluated once, after the choice was fixed. Results are in
`ml/experiments/*.json`; version 1 test metrics are kept in `ml/experiments/v1_artifacts/`.

| Validation 2025, CNN-LSTM | Temp MAE °C | Humidity MAE % | Rain MAE mm |
| --- | --- | --- | --- |
| Direct, 48 h (version 1) | 1.208 | 6.075 | 0.1271 |
| Residual, 48 h | 1.053 | 5.899 | 0.1275 |
| Residual, 72 h | 1.066 | 5.935 | 0.1294 |
| Residual, 72 h, sample every 2 h | 1.075 | 5.912 | 0.1346 |
| Residual, 72 h, every 2 h, Huber | 1.052 | 5.880 | 0.1108 |
| **Residual, 48 h, Huber (chosen)** | **1.051** | **5.814** | **0.1096** |
| Persistence baseline | 1.203 | 6.625 | – |

Test period (Jan–Oct 2026), evaluated once after the choice. Version 1 → version 2, MAE:

| Model | Temperature °C | Humidity % | Rain mm |
| --- | --- | --- | --- |
| LSTM | 1.326 → 1.224 | 6.446 → 6.630 | 0.125 → 0.118 |
| GRU | 1.305 → **1.178** | 6.220 → 6.372 | 0.128 → 0.116 |
| CNN-LSTM | 1.374 → 1.196 | 6.431 → 6.449 | 0.129 → 0.117 |
| Persistence | 1.383 | 7.592 | 0.183 |

The result is mixed and reported as measured: temperature improved for every model (8–13% lower MAE, and better
against weather stations), but humidity got slightly worse on the test year although it improved on validation,
and rain's typical error fell while its RMSE and R² got worse (Huber loss trades big-storm accuracy for typical
hours). Tuning further against these test numbers would leak the test set into model selection, so it wasn't done.

### How leakage is prevented

- **Chronological split**: train 2023–2024, validation 2025, test Jan–Oct 2026. No shuffling across time.
- **Whole windows only**: a sample counts only if all 48 input hours and all 24 target hours fall inside one split
  and one city, so nothing straddles a boundary (`dataset.window_ends`, covered by tests).
- **Scaler fitted on training rows only** (`preprocess.Preprocessor.fit`), then saved with the model.
- **Same pipeline at inference**: the API calls the same `features.build_frames` and loads the saved
  `preprocessor.json`, which refuses to run if the feature columns or their order differ.
- **No silent gap filling**: gaps of up to 3 hours are interpolated; longer gaps make the window invalid.

### Honest evaluation

- Every metric is on the 2026 test period, which training never saw.
- A **persistence baseline** (same hour yesterday) is reported next to every model.
- **Error ranges** use split conformal prediction calibrated on the validation year; the Models page shows how
  often test values actually fell inside them.
- A **station check** compares test predictions with Meteostat weather-station measurements, and scores
  Open-Meteo's own data against the same stations to show the data source's error floor.
- Models only predict for the ten trained cities. Elsewhere the API answers `unsupported_location`.
- Training targets are Open-Meteo model data, not observations; live inputs come from the same model family.

## API

| Method and path | Purpose |
| --- | --- |
| `GET /api/health` | Database status and available models |
| `GET /api/coverage` | Cities the models cover |
| `GET /api/models`, `/api/models/{name}` | Metrics from the evaluation run |
| `GET /api/models/{name}/evaluation?city=&include_samples=` | Per-horizon and per-city errors, actual-vs-predicted samples |
| `GET /api/predictions?latitude=&longitude=&models=` | Live 24-hour predictions with error ranges; stored in PostgreSQL |
| `GET/POST/PUT /api/places`, `PUT/DELETE /api/places/{id}/home`, `DELETE /api/places/{id}` | Saved places per `X-Client-Id` (`PUT` replaces the whole list) |

Interactive docs: http://localhost:8000/docs.

## Configuration

All settings come from environment variables with the `WEATHERAI_` prefix (see `backend/.env.example`).
Secrets live only in `backend/.env`, which is git-ignored. Open-Meteo and Meteostat need no API keys.

## Deployment

`docker compose up --build` runs PostgreSQL, the API and the nginx-served frontend on http://localhost:8080.
Set `POSTGRES_PASSWORD` in a `.env` next to `docker-compose.yml`. The Docker files were written but not run on the
development machine (Docker isn't installed there), so test them before relying on them.

## Data sources and labelling

| What you see | Source | Label in the UI |
| --- | --- | --- |
| Current conditions, past hours | Open-Meteo forecast models | "Open-Meteo model estimate" / solid line |
| Forecast | Open-Meteo forecast | "Open-Meteo forecast" / dashed line |
| WeatherAI predictions | Our LSTM, GRU, CNN-LSTM | Model colour, dithered error range |
| Historical trends | Open-Meteo archive (ERA5) | Named under the chart |
| Station check | Meteostat | Models page |

## Design system

- Colours are CSS variables in `src/index.css` (light and high-contrast dark). Chart colours are mirrored in
  `src/lib/chartTheme.ts` because SVG attributes can't read CSS variables.
- Fonts: Tahoma (Verdana fallback) for the interface, Pixelify Sans for big numbers, VT323 for terminal text.
- Accessibility: Radix Tabs, an ARIA combobox for search, dotted focus rectangles, table alternatives,
  and reduced motion through Motion's `MotionConfig`.
