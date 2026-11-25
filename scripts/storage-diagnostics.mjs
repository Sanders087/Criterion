// Read an existing database only; do not run migrations or create a missing database.
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { diagnostic, safeErrorCode, storageSnapshot } from '../lib/diagnostics.mjs';

export function inspectStorage(filename) {
  const state = storageSnapshot(filename, 'read_only_inspection');
  if (state.database.exists !== true || state.database.type !== 'file') {
    diagnostic('database.inspection', { status: 'unavailable', reason: 'file_unavailable' }, 'error');
    return false;
  }
  let database;
  try {
    database = new DatabaseSync(state.databasePath, { readOnly: true });
    const actual = database.prepare('PRAGMA database_list').all().find(row => row.name === 'main');
    const queryOk = database.prepare('SELECT 1 AS ready').get().ready === 1;
    diagnostic('database.inspection', { status: 'ready', databasePath: actual.file, queryOk, readOnlyConnection: true });
    return queryOk;
  } catch (error) {
    diagnostic('database.inspection', { status: 'unavailable', errorCode: safeErrorCode(error) }, 'error');
    return false;
  } finally { database?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const filename = process.env.DATABASE_PATH;
  if (!filename) {
    diagnostic('database.inspection', { status: 'unavailable', reason: 'path_not_configured' }, 'error');
    process.exitCode = 1;
  } else process.exitCode = inspectStorage(resolve(filename)) ? 0 : 1;
}
