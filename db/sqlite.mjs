import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Parameterized SQL adapter shared by the ORM and the transactional auth/payment code.
export function openDatabase(path, { migrate = true, migrationsDir = process.env.MIGRATIONS_DIR || resolve('drizzle') } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const native = new DatabaseSync(path);
  native.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
  class Statement {
    constructor(sql, params = []) { this.sql = sql; this.params = params; }
    bind(...params) { return new Statement(this.sql, params); }
    /** @template [T=Record<string, unknown>] @returns {T|null} */
    first() { return /** @type {T|null} */ (native.prepare(this.sql).get(...this.params) ?? null); }
    all() { return { results: native.prepare(this.sql).all(...this.params) }; }
    run() {
      const result = native.prepare(this.sql).run(...this.params);
      return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
    }
  }
  function transaction(callback) {
    native.exec('BEGIN IMMEDIATE');
    try { const result = callback(); native.exec('COMMIT'); return result; }
    catch (error) { native.exec('ROLLBACK'); throw error; }
  }
  function query(sql, params, method) {
    const statement = native.prepare(sql);
    if (method === 'run') { statement.run(...params); return { rows: [] }; }
    statement.setReturnArrays(true);
    return { rows: method === 'get' ? statement.get(...params) : statement.all(...params) };
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
    });
  } catch (error) { native.close(); throw error; }
  return {
    prepare: sql => new Statement(sql),
    // This connection and its transaction callback are synchronous.
    writeTransaction: transaction,
    batch: statements => transaction(() => statements.map(statement => statement.run())),
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
