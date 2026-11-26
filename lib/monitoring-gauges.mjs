import { resolve } from 'node:path';
import { readUnresolvedPaymentCount } from './payment-reconciliation.mjs';
import { DatabaseSync } from 'node:sqlite';
import { collectStorageMetrics } from './storage-monitor.mjs';

// These are private aggregate gauges. A failed measurement must never look like a healthy zero.
const cacheKey = Symbol.for('criterion.monitoring.gauges.v1');
export function monitoringGauges() {
  const now = Date.now();
  const previous = globalThis[cacheKey];
  if (previous && now - previous.timestamp < 15000) return previous.values;
  const filename = resolve(process.env.DATABASE_PATH || 'work/criterion.sqlite');
  const storage = collectStorageMetrics(filename);
  const values = {
    sqlite_available: 0, sqlite_database_size_bytes: storage.databaseBytes, sqlite_wal_size_bytes: storage.walBytes,
    storage_free_bytes: storage.freeBytes, storage_writable: storage.writable === null ? null : Number(storage.writable),
    backup_last_success_timestamp_seconds: storage.backup.lastSuccessTimestampSeconds,
    backup_last_run_failed: storage.backup.status === 'unknown' ? null : Number(storage.backup.status === 'failed'),
    payment_unresolved_orders:null, payment_confirmed_without_access:null,
  };
  let db;
  try {
    db = new DatabaseSync(filename,{readOnly:true});
    values.payment_unresolved_orders = readUnresolvedPaymentCount(db);
    values.payment_confirmed_without_access = db.prepare(`SELECT count(*) AS n FROM payment_orders o
      JOIN documents d ON d.id=o.document_id AND d.owner=o.owner
      WHERE o.status IN ('CONFIRMED','PARTIAL_REFUNDED') AND d.billing_state NOT IN ('legacy','paid')`).get().n;
    values.sqlite_available = 1;
  } catch { /* The other gauges still describe the filesystem. */ }
  finally { db?.close(); }
  globalThis[cacheKey] = {timestamp:now,values};
  return values;
}
