# One application: Next.js + SQLite + the private Python PII detector.
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS site-build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df AS python-deps
COPY services/pii/requirements.lock.txt /tmp/pii-requirements.txt
RUN python -m venv /opt/pii && /opt/pii/bin/pip install --no-cache-dir -r /tmp/pii-requirements.txt && /opt/pii/bin/pip check

FROM site-build AS test
RUN --network=none pnpm test && pnpm test:integration

# Keep the Python OS libraries together; copying Python into a Node image loses libssl.
FROM python-deps AS runtime
COPY --from=site-build /usr/local/bin/node /usr/local/bin/node
RUN groupadd --gid 10001 criterion && useradd --uid 10001 --gid criterion --no-create-home --shell /usr/sbin/nologin criterion && mkdir /data && chown criterion:criterion /data
WORKDIR /app
COPY --from=site-build --chown=criterion:criterion /app/.next/standalone/ ./
COPY --from=site-build --chown=criterion:criterion /app/.next/static/ ./.next/static/
COPY --from=site-build --chown=criterion:criterion /app/public/ ./public/
COPY --chown=criterion:criterion drizzle/ ./drizzle/
COPY --chown=criterion:criterion db/sqlite.mjs ./db/sqlite.mjs
COPY --chown=criterion:criterion lib/diagnostics.mjs lib/diagnostic-schema.mjs lib/request-context.mjs ./lib/
COPY --chown=criterion:criterion scripts/start-site.mjs scripts/run-with-pii.mjs scripts/check-pii-endpoint.py scripts/backup-db.py scripts/storage-diagnostics.mjs ./scripts/
COPY --chown=criterion:criterion services/pii/__init__.py services/pii/app.py services/pii/detector.py ./services/pii/
COPY deploy/amvera/entrypoint.py /entrypoint.py
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000     DATABASE_PATH=/data/criterion.sqlite MIGRATIONS_DIR=/app/drizzle SITE_HEALTH_PATH=/api/health     PII_PYTHON=/opt/pii/bin/python PATH=/opt/pii/bin:$PATH OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=6s --start-period=90s --retries=3 CMD ["node", "scripts/run-with-pii.mjs", "--healthcheck"]
# Entrypoint gives a fresh mounted /data to uid 10001, then permanently drops root.
ENTRYPOINT ["python", "/entrypoint.py"]
CMD ["node", "scripts/run-with-pii.mjs", "--", "node", "scripts/start-site.mjs", "server.js"]
