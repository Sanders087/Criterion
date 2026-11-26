import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase } from '../db/sqlite.mjs';

test('Upgrade a populated copy from P0 without losing the user, their session, or an unresolved payment', t => {
  const dir = mkdtempSync(join(tmpdir(), 'criterion-upgrade-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const migrationsDir = join(dir, 'p0-migrations');
  mkdirSync(migrationsDir);
  const files = readdirSync(resolve('drizzle')).filter(name => /^000[0-3]_.*\.sql$/.test(name));
  assert.equal(files.length, 4);
  for (const name of files) copyFileSync(resolve('drizzle', name), join(migrationsDir, name));
  const original = join(dir, 'p0.sqlite');
  const copy = join(dir, 'upgrade.sqlite');
  const db = openDatabase(original, { migrationsDir });
  try {
    db.prepare('INSERT INTO accounts(id,email,password_hash,salt,recovery_hash,created_at) VALUES(?,?,?,?,?,?)')
      .bind('acct','fixture@example.test','test-hash','test-salt','test-recovery',1).run();
    db.prepare('INSERT INTO sessions(token_hash,account_id,expires_at) VALUES(?,?,?)').bind('test-session','acct',900000).run();
    db.prepare('INSERT INTO payment_orders(id,document_id,owner,active_document,amount,terminal_key,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .bind('legacy-order','document','acct','document',19900,'fixture','INITIALIZING',1,1).run();
  } finally { db.close(); }
  // The sole connection is closed, so the fixture can be copied consistently.
  copyFileSync(original, copy);
  for (let attempt = 0; attempt < 2; attempt++) {
    const upgraded = openDatabase(copy);
    try {
      assert.equal(upgraded.prepare('SELECT a.id FROM accounts a JOIN sessions s ON s.account_id=a.id WHERE s.token_hash=?').bind('test-session').first().id, 'acct');
      const row = upgraded.prepare('SELECT status, active_document FROM payment_orders WHERE id=?').bind('legacy-order').first();
      assert.equal(row.status, 'INITIALIZING');
      assert.equal(row.active_document, 'document');
      assert.ok(upgraded.prepare('SELECT count(*) AS n FROM _criterion_migrations').first().n > 4);
      assert.equal(upgraded.prepare('PRAGMA quick_check').first().quick_check, 'ok');
    } finally { upgraded.close(); }
  }
});
