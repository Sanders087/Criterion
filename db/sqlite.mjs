import { diagnostic } from '../lib/diagnostics.mjs';
import { databaseFailure } from '../lib/diagnostic-storage.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Parameterized SQL adapter shared by the ORM and the transactional auth/payment code.
export function openDatabase(path, { migrate = true, busyTimeoutMs = 5000, migrationsDir = process.env.MIGRATIONS_DIR || resolve('drizzle') } = {}) {
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60000) throw new Error('Invalid busy timeout');
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const native = new DatabaseSync(path);
  try { native.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;`); }
  catch (cause) { native.close(); throw cause; }
  // The native connection is synchronous. Defer named statement successes until commit,
  // so a later rollback cannot publish a successful payment grant.
  let activeTransaction = null;
  function fail(operation, error, start, details = {}) {
    const reason = databaseFailure(error);
    const durationMs = Math.round(performance.now() - start);
    const fallback = details.transaction ? 'DB_TRANSACTION_FAILED' : 'DATABASE_ERROR';
    const errorCode = !reason || reason.errorCode === 'DATABASE_ERROR' ? fallback : reason.errorCode;
    diagnostic('database.operation_failed',{operation,...reason,errorCode,durationMs,
      ...(errorCode === 'DB_BUSY' ? {busyTimeoutMs,busyTimeoutElapsed:reason?.causeCode==='SQLITE_BUSY_TIMEOUT' ||
        (busyTimeoutMs > 0 && durationMs >= busyTimeoutMs)} : {}),...details},'error');
  }
  function statement(operation, callback) {
    const started = performance.now();
    try {
      const result = callback();
      if (operation) {
        const fields = {operation,durationMs:Math.round(performance.now()-started)};
        if (activeTransaction) activeTransaction.completed.push(fields);
        else diagnostic('database.operation_completed',fields);
      }
      return result;
    } catch (cause) {
      if (activeTransaction) activeTransaction.failedOperation = operation;
      else fail(operation || 'database.query',cause,started);
      throw cause;
    }
  }
  class Statement {
    constructor(sql, params = []) { this.sql = sql; this.params = params; }
    bind(...params) { return new Statement(this.sql, params); }
    /** @template [T=Record<string, unknown>] @returns {T|null} */
    first() { return /** @type {T|null} */ (statement(undefined,() => native.prepare(this.sql).get(...this.params)) ?? null); }
    all() { return { results: statement(undefined,() => native.prepare(this.sql).all(...this.params)) }; }
    /** @param {string} [operation] */
    run(operation) {
      const result = statement(operation,() => native.prepare(this.sql).run(...this.params));
      return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    }
  }
  /** @template T @param {() => T} callback @param {string} [operation] @returns {T} */
  function transaction(callback, operation) {
    const started = performance.now();
    const frame = { completed:[], failedOperation:undefined };
    let began = false;
    try {
      native.exec('BEGIN IMMEDIATE');
      began = true;
      activeTransaction = frame;
      const result = callback();
      native.exec('COMMIT');
      for (const fields of frame.completed) diagnostic('database.operation_completed',fields);
      if (operation) diagnostic('database.operation_completed',{operation,durationMs:Math.round(performance.now()-started)});
      return result;
    } catch (cause) {
      let rolledBack = false, rollbackFailed = false;
      if (began) {
        try {
          // Some SQLite errors end the transaction automatically.
          if (native.isTransaction) native.exec('ROLLBACK');
          rolledBack = true;
        } catch { rollbackFailed = true; }
      }
      if (!began && activeTransaction) {
        // A nested BEGIN was rejected by SQLite. Its outer transaction records the rollback once.
        activeTransaction.failedOperation = operation || 'database.transaction';
      } else {
        fail(frame.failedOperation || operation || 'database.transaction',cause,started,{
          transaction:true,rolledBack,rollbackFailed,parentOperation:frame.failedOperation ? operation : undefined});
      }
      throw cause;
    } finally { if (began) activeTransaction = null; }
  }
  /** @param {string} sql @param {any[]} params @param {string} method @param {string} [operation] */
  function query(sql, params, method, operation) {
    return statement(operation,() => {
      const prepared = native.prepare(sql);
      if (method === 'run') { prepared.run(...params); return { rows: [] }; }
      prepared.setReturnArrays(true);
      return { rows: method === 'get' ? prepared.get(...params) : prepared.all(...params) };
    });
  }
  try {
    if (migrate) transaction(() => {
      const tracked = native.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='_criterion_migrations'").get();
      if (!tracked && native.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='documents'").get()) {
        throw new Error('Existing untracked database: import must be performed explicitly.');
      }
      native.exec('CREATE TABLE IF NOT EXISTS _criterion_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL)');
      const names = readdirSync(migrationsDir).filter(name => /^\d+_[\w-]+\.sql$/.test(name)).sort();
      if (!names.length) throw new Error('Database migration files are missing.');
      const previous = native.prepare('SELECT name,checksum FROM _criterion_migrations').all();
      if (previous.some(row => !names.includes(String(row.name)))) throw new Error('An applied migration is missing.');
      for (const name of names) {
        const sql = readFileSync(resolve(migrationsDir, name), 'utf8').replace(/\r\n?/g, '\n');
        const checksum = createHash('sha256').update(sql).digest('hex');
        const applied = previous.find(row => row.name === name);
        if (applied) { if (applied.checksum !== checksum) throw new Error('Applied migration changed: ' + name); continue; }
        native.exec(sql);
        native.prepare('INSERT INTO _criterion_migrations (name,checksum) VALUES (?,?)').run(name, checksum);
      }
    }, 'database.migrate');
  } catch (error) { native.close(); throw error; }
  return {
    prepare: sql => new Statement(sql),
    // This connection and its transaction callback are synchronous.
    writeTransaction: transaction,
    /** @param {Statement[]} statements @param {string} [operation] */
    batch: (statements, operation) => transaction(() => statements.map(statement => statement.run()), operation),
    query,
    queryBatch: queries => transaction(() => queries.map(item => query(item.sql, item.params, item.method))),
    close: () => native.close(),
  };
}
const key = Symbol.for('criterion.sqlite.connection');
export function getDatabase() {
  const path = process.env.DATABASE_PATH || (process.env.NODE_ENV === 'production' ? '' : 'work/criterion.sqlite');
  if (!path) throw new Error('DATABASE_PATH must be set for the production server.');
  const filename = resolve(path);
  if (!globalThis[key]) globalThis[key] = { filename, database: openDatabase(filename) };
  if (globalThis[key].filename !== filename) throw new Error('Database path changed while the server was running.');
  return globalThis[key].database;
}
