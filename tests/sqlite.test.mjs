import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../db/sqlite.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'criterion-sqlite-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test('SQLite persists data, applies migrations once, and binds values safely', t => {
  const path = join(fixture(t), 'data.sqlite');
  let db = openDatabase(path);
  const value = "owner'; DROP TABLE accounts; --";
  db.prepare('INSERT INTO materials(owner,body,updated_at) VALUES(?,?,?)').bind(value, '{}', '2026-01-01').run();
  const count = db.prepare('SELECT count(*) AS n FROM _criterion_migrations').first().n;
  db.close(); db = openDatabase(path);
  try { assert.equal(db.prepare('SELECT owner FROM materials').first().owner, value);
    assert.equal(db.prepare('SELECT count(*) AS n FROM _criterion_migrations').first().n, count); }
  finally { db.close(); }
});
test('SQLite batch rolls back all statements after a constraint failure', () => {
  const db = openDatabase(':memory:');
  try {
    const insert = db.prepare('INSERT INTO materials(owner,body,updated_at) VALUES(?,?,?)');
    assert.throws(() => db.batch([insert.bind('same', '{}', 'now'), insert.bind('same', '{}', 'now')]));
    assert.equal(db.prepare('SELECT count(*) AS n FROM materials').first().n, 0);
    assert.equal(db.batch([insert.bind('one', '{}', 'now'), insert.bind('two', '{}', 'now')])[1].meta.changes, 1);
    assert.deepEqual(db.query('SELECT owner FROM materials ORDER BY owner', [], 'all').rows, [['one'], ['two']]);
  } finally { db.close(); }
});
test('Changed or missing applied migrations stop startup', t => {
  const directory = fixture(t), migrationsDir = join(directory, 'migrations'), path = join(directory, 'db.sqlite');
  mkdirSync(migrationsDir); writeFileSync(join(migrationsDir, '0000_initial.sql'), 'CREATE TABLE example(id TEXT);');
  openDatabase(path, { migrationsDir }).close();
  writeFileSync(join(migrationsDir, '0000_initial.sql'), 'CREATE TABLE example(id INTEGER);');
  assert.throws(() => openDatabase(path, { migrationsDir }), /Applied migration changed/);
  rmSync(join(migrationsDir, '0000_initial.sql')); writeFileSync(join(migrationsDir, '0001_next.sql'), 'SELECT 1;');
  assert.throws(() => openDatabase(path, { migrationsDir }), /applied migration is missing/);
});
test('A failed migration is atomic and can be retried after correction', t => {
  const directory = fixture(t), migrationsDir = join(directory, 'migrations'), path = join(directory, 'db.sqlite');
  mkdirSync(migrationsDir); const file = join(migrationsDir, '0000_initial.sql');
  writeFileSync(file, 'CREATE TABLE example(id TEXT); INVALID SQL;');
  assert.throws(() => openDatabase(path, { migrationsDir }));
  writeFileSync(file, 'CREATE TABLE example(id TEXT);');
  const db = openDatabase(path, { migrationsDir });
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM example').first().n, 0); } finally { db.close(); }
});
test('An untracked pre-existing application database is never silently reinitialized', t => {
  const path = join(fixture(t), 'old.sqlite'), db = openDatabase(path, { migrate: false });
  db.prepare('CREATE TABLE documents(id TEXT)').run(); db.close();
  assert.throws(() => openDatabase(path), /Existing untracked database/);
});

test('P1 migration preserves legacy account, outstanding token and pending payment on reopen', t => {
  const directory = fixture(t), migrationsDir = join(directory, 'before'), path = join(directory, 'legacy.sqlite');
  mkdirSync(migrationsDir);
  for (const name of readdirSync('drizzle').filter(name => /^000[0-3]_/.test(name) && name.endsWith('.sql'))) {
    copyFileSync(join('drizzle',name),join(migrationsDir,name));
  }
  const legacy = openDatabase(path,{migrationsDir});
  legacy.prepare('INSERT INTO accounts(id,email,password_hash,salt,recovery_hash,created_at) VALUES (?,?,?,?,?,?)').bind('account','legacy@example.test','hash','salt','recovery',1).run();
  legacy.prepare('INSERT INTO email_tokens(token_hash,account_id,email,purpose,credential_hash,expires_at) VALUES (?,?,?,?,?,?)').bind('token-hash','account','legacy@example.test','verify','hash',1000).run();
  legacy.prepare("INSERT INTO payment_orders(id,document_id,owner,amount,terminal_key,status,created_at,updated_at) VALUES ('order','doc','account',19900,'fixture','INITIALIZING',1,1)").run();
  legacy.close();
  const migrated = openDatabase(path);
  try {
    assert.equal(migrated.prepare('SELECT email FROM accounts').first().email,'legacy@example.test');
    assert.equal(migrated.prepare('SELECT token_hash FROM email_tokens').first().token_hash,'token-hash');
    const order = migrated.prepare('SELECT status,first_missing_at,cancel_requested_at FROM payment_orders').first();
    assert.deepEqual({...order},{status:'INITIALIZING',first_missing_at:0,cancel_requested_at:0});
    assert.equal(migrated.prepare('SELECT count(*) n FROM mail_attempts').first().n,0);
  } finally { migrated.close(); }
  openDatabase(path).close();
});
