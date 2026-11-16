import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { localMigrationChecksums } from '../scripts/local-migration-checksums.mjs';

const lf = "CREATE TABLE example (id TEXT PRIMARY KEY);\nINSERT INTO example VALUES ('kept');\n";
const crlf = lf.replace(/\n/g, '\r\n');
const legacyHash = (sql: string) => createHash('sha256').update(sql).digest('hex');

test('local migration checks accept existing LF and CRLF records without reapplying SQL', () => {
  for (const current of [lf, crlf]) {
    const hashes = localMigrationChecksums(current);
    assert.equal(hashes.canonical, legacyHash(lf));
    for (const previous of [lf, crlf]) assert.ok(hashes.accepted.has(legacyHash(previous)));
  }
});

test('changing applied SQL is rejected even when line endings also change', () => {
  for (const changed of [lf.replace('kept', 'replaced'), lf + 'DROP TABLE example;\n', lf.replace('id TEXT', 'id  TEXT')]) {
    for (const current of [changed, changed.replace(/\n/g, '\r\n')]) {
      const hashes = localMigrationChecksums(current);
      assert.equal(hashes.accepted.has(legacyHash(lf)), false);
      assert.equal(hashes.accepted.has(legacyHash(crlf)), false);
    }
  }
});

test('unrecognized stored migration checksums are rejected', () => {
  const hashes = localMigrationChecksums(lf);
  for (const recorded of ['', '0'.repeat(64), legacyHash('')]) assert.equal(hashes.accepted.has(recorded), false);
});
