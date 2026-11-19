# WeatherAI API. Build from the repository root:
#   docker build -f backend/Dockerfile -t weatherai-api .
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TF_CPP_MIN_LOG_LEVEL=2
WORKDIR /srv

COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# Shared pipeline package and the trained artifacts (no raw training data).
COPY ml/pyproject.toml ml/pyproject.toml
COPY ml/weatherai_ml ml/weatherai_ml
RUN pip install --no-cache-dir ./ml
COPY ml/artifacts ml/artifacts
COPY backend/app backend/app

ENV WEATHERAI_ARTIFACTS_DIR=/srv/ml/artifacts
WORKDIR /srv/backend
EXPOSE 8000
RUN useradd --create-home app
USER app
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
