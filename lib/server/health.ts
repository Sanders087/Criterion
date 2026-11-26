import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { storageWritable } from '../storage-monitor.mjs';
import { DatabaseSync } from 'node:sqlite';
import { integrationObservation } from '../diagnostic-integrations.mjs';
import { detectorEndpoint, type PrivacyEnv } from '../criterion/privacy-detector';
import { checkoutReady, type TBankEnv } from '../criterion/tbank';
import { mailReady, type MailConfig } from '../criterion/mail';

function sqliteHealth() {
  const filename = process.env.DATABASE_PATH || (process.env.NODE_ENV === 'production' ? '' : 'work/criterion.sqlite');
  const status = { configured: Boolean(filename), reachable: false, functional: false, lastCheckedAt: new Date().toISOString() };
  if (!filename) return status;
  let db: DatabaseSync | undefined;
  try {
    // Open read-only: readiness must never create a missing file or apply a migration.
    db = new DatabaseSync(filename, { readOnly: true });
    status.reachable = true;
    // SQLite writes to the main file and may need to create or update its sidecars.
    if (storageWritable(filename) !== true) return status;
    const actual = db.prepare('SELECT name FROM _criterion_migrations ORDER BY name').all();
    const expected = readdirSync(process.env.MIGRATIONS_DIR || resolve('drizzle')).filter(name => /^\d+_[\w-]+\.sql$/.test(name)).sort();
    status.functional = expected.length > 0 && actual.length === expected.length &&
      actual.every((row, i) => row.name === expected[i]);
  } catch { /* The public probe gives no filesystem or SQL details. */ }
  finally { db?.close(); }
  return status;
}

async function detectorHealth() {
  const status = { configured: false, reachable: false, ready: false, lastCheckedAt: new Date().toISOString() };
  try {
    const { url, token } = detectorEndpoint(process.env as PrivacyEnv);
    status.configured = true;
    const response = await fetch(new URL('/health', url), {
      headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(1000), redirect: 'manual', cache: 'no-store',
    });
    status.reachable = true;
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      return status;
    }
    // The trusted endpoint returns a small JSON object. Never retain an arbitrary body.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0, body = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 512) { await reader.cancel(); return status; }
        body += decoder.decode(value, { stream: true });
      }
      status.ready = JSON.parse(body + decoder.decode())?.status === 'ready';
    } finally { reader.releaseLock(); }
  } catch { /* No raw body, token, URL or cause goes into health responses. */ }
  return status;
}

type Snapshot = { sqlite: ReturnType<typeof sqliteHealth>, piiDetector: Awaited<ReturnType<typeof detectorHealth>> };
const cacheKey = Symbol.for('criterion.internal-health.v1');
const globalCache = globalThis as typeof globalThis & { [cacheKey]?: { expiresAt: number, pending?: Promise<Snapshot> } };
export function internalHealth(): Promise<Snapshot> {
  const cache = globalCache[cacheKey] ??= { expiresAt: 0 };
  if (cache.pending && Date.now() < cache.expiresAt) return cache.pending;
  // Keep an in-flight probe shared across callers, including calls from different Next bundles.
  cache.expiresAt = Infinity;
  cache.pending = Promise.all([sqliteHealth(), detectorHealth()]).then(([sqlite, piiDetector]) => ({ sqlite, piiDetector }))
    .finally(() => { cache.expiresAt = Date.now() + 2000; });
  return cache.pending;
}

export async function integrationHealth() {
  const { sqlite, piiDetector } = await internalHealth();
  const bank = checkoutReady(process.env as TBankEnv);
  const pii = integrationObservation('piiDetector');
  return {
    sqlite: sqlite.configured ? sqlite : { configured: false, reachable: 'unknown', functional: 'unknown', lastCheckedAt: null },
    piiDetector: piiDetector.configured
      ? { configured: true, reachable: piiDetector.reachable, functional: piiDetector.ready ? pii.functional : false, lastCheckedAt: piiDetector.lastCheckedAt,
          lastFunctionalCheckAt: piiDetector.ready ? pii.lastCheckedAt : piiDetector.lastCheckedAt }
      : { configured: false, reachable: 'unknown', functional: 'unknown', lastCheckedAt: null, lastFunctionalCheckAt: null },
    ai: { configured: Boolean(process.env.OPENAI_API_KEY?.trim()), ...integrationObservation('ai') },
    resend: { configured: mailReady(process.env as MailConfig), ...integrationObservation('resend') },
    bank: { configured: bank, ...integrationObservation('bank') },
    paymentGateway: { configured: bank && Boolean(process.env.TBANK_GATEWAY_URL), ...integrationObservation('paymentGateway') },
  };
}
