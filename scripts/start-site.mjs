import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDatabase } from '../db/sqlite.mjs';

try {
  const url = new URL(process.env.AUTH_PUBLIC_URL || '');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('Invalid AUTH_PUBLIC_URL');
  }
  process.env.MIGRATIONS_DIR ||= resolve('drizzle');
  getDatabase().close();
  delete globalThis[Symbol.for('criterion.sqlite.connection')];
  console.log('Criterion: database migrations ready.');
  await import(pathToFileURL(resolve(process.argv[2] || '.next/standalone/server.js')).href);
} catch {
  console.error('Criterion: site startup failed. Check AUTH_PUBLIC_URL, database permissions and migration files.');
  process.exitCode = 1;
}
