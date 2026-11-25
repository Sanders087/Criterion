import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDatabase } from '../db/sqlite.mjs';
import { diagnostic, safeErrorCode, storageSnapshot, integrationConfiguration } from '../lib/diagnostics.mjs';

let phase = 'configuration';
try {
  const url = new URL(process.env.AUTH_PUBLIC_URL || '');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('Invalid AUTH_PUBLIC_URL');
  }
  integrationConfiguration();
  const configuredPath = process.env.DATABASE_PATH || (process.env.NODE_ENV === 'production' ? '' : 'work/criterion.sqlite');
  const beforeOpen = configuredPath ? storageSnapshot(configuredPath, 'before_open') : null;
  process.env.MIGRATIONS_DIR ||= resolve('drizzle');
  phase = 'database_open_and_migrations';
  const database = getDatabase();
  try {
    const actual = database.prepare('PRAGMA database_list').all().results.find(row => row.name === 'main');
    const queryOk = database.prepare('SELECT 1 AS ready').first().ready === 1;
    const journalMode = database.prepare('PRAGMA journal_mode').first().journal_mode;
    diagnostic('database.ready', { databasePath: actual.file, existedBeforeOpen: beforeOpen?.database.exists ?? null, queryOk, migrationsOk: true, journalMode });
    storageSnapshot(actual.file, 'after_open');
  } finally {
    database.close();
    delete globalThis[Symbol.for('criterion.sqlite.connection')];
  }
  console.log('Criterion: database migrations ready.');
  phase = 'site_start';
  diagnostic('site.starting');
  await import(pathToFileURL(resolve(process.argv[2] || '.next/standalone/server.js')).href);
} catch (error) {
  diagnostic('startup.failed', { phase, errorCode: safeErrorCode(error) }, 'error');
  console.error('Criterion: site startup failed. Check AUTH_PUBLIC_URL, database permissions and migration files.');
  process.exitCode = 1;
}
