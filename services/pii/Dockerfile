# Build from repository root: docker build -f services/pii/Dockerfile ... .
FROM python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY services/pii/requirements.lock.txt /app/requirements.lock.txt
RUN python -m pip install --no-cache-dir -r requirements.lock.txt && python -m pip check
RUN groupadd --gid 10001 pii && useradd --uid 10001 --gid pii --no-create-home --shell /usr/sbin/nologin pii
COPY services/pii/__init__.py services/pii/app.py services/pii/detector.py services/pii/healthcheck.py /app/services/pii/
COPY scripts/check-pii-endpoint.py /app/scripts/check-pii-endpoint.py
USER 10001:10001
# Keep NumPy/BLAS from oversubscribing the fractional container CPU quota.
ENV OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1

FROM base AS test
COPY services/pii/test_pii.py services/pii/benchmark.py /app/services/pii/
COPY tests/fixtures/pii-corpus.jsonl /app/tests/fixtures/pii-corpus.jsonl
RUN --network=none python -m unittest services.pii.test_pii -v
# Quality report is intentionally not a green release gate (known false positives).
RUN --network=none python -m services.pii.benchmark --output /tmp/pii-benchmark.json

FROM base AS runtime
EXPOSE 8100
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["python", "-m", "services.pii.healthcheck"]
CMD ["python", "-m", "uvicorn", "services.pii.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8100", "--workers", "1", "--no-access-log", "--limit-concurrency", "4"]
