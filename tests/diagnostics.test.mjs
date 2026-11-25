import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { serviceStatus } from '../scripts/run-with-pii.mjs';
import { parseMountInfo, fileMetadata, safeErrorCode, integrationConfiguration } from '../lib/diagnostics.mjs';

const inspector = fileURLToPath(new URL('../scripts/storage-diagnostics.mjs', import.meta.url));
function inspect(filename) {
  const result = spawnSync(process.execPath, [inspector], { encoding: 'utf8', windowsHide: true,
    env: { ...process.env, DATABASE_PATH: filename }, timeout: 10000 });
  const events = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const errors = result.stderr.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  return { ...result, events: [...events, ...errors] };
}
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'criterion-diagnostics-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Mount inspection distinguishes container root, dedicated volume and unknown metadata', () => {
  const root = '20 1 0:1 / / rw - overlay overlay rw,secret-option=do-not-log';
  const volume = '35 20 8:1 /private-volume-id /data rw - ext4 /private-device rw';
  const data = parseMountInfo(root + '\n' + volume, '/data/criterion.sqlite');
  assert.deepEqual(data, { mountPoint: '/data', filesystem: 'ext4', readOnly: false, separateMount: true, persistenceVerified: false });
  assert.equal(parseMountInfo(root + '\n' + volume, '/database/criterion.sqlite').separateMount, false);
  assert.equal(parseMountInfo(root, '/data/criterion.sqlite').mountPoint, '/');
  assert.equal(parseMountInfo('', '/data/criterion.sqlite').status, 'unknown');
  assert.equal(parseMountInfo('42 20 8:2 / /data\\040copy ro - ext4 /dev/private rw', '/data copy/file.sqlite').readOnly, true);
  assert.doesNotMatch(JSON.stringify(data), /private|secret-option/);
});

test('Read-only inspection reports the actual SQLite path without exposing rows or modifying the database', t => {
  const filename = join(temporary(t), 'original.sqlite');
  const db = new DatabaseSync(filename);
  db.exec('CREATE TABLE accounts(email TEXT, password_hash TEXT)');
  db.prepare('INSERT INTO accounts VALUES (?, ?)').run('private-fixture@example.test', 'private-fixture-password-hash');
  db.close();
  const before = readFileSync(filename);
  const result = inspect(filename);
  assert.equal(result.status, 0, result.stderr);
  const check = result.events.find(event => event.event === 'database.inspection');
  assert.equal(check.databasePath.replaceAll('\\', '/'), filename.replaceAll('\\', '/'));
  assert.equal(check.queryOk, true);
  assert.equal(check.readOnlyConnection, true);
  assert.deepEqual(readFileSync(filename), before);
  assert.doesNotMatch(result.stdout + result.stderr, /private-fixture/);
});

test('Inspection of a missing database fails without creating a file or directory', t => {
  const filename = join(temporary(t), 'missing', 'new.sqlite');
  const result = inspect(filename);
  assert.equal(result.status, 1);
  assert.equal(result.events[0].database.exists, false);
  assert.equal(existsSync(filename), false);
  assert.equal(existsSync(join(filename, '..')), false);
  assert.equal(fileMetadata(filename).errorCode, 'ENOENT');
});

test('Configured external services are not reported as tested, and credential values never enter configuration logs', t => {
  const lines = [];
  t.mock.method(console, 'log', line => lines.push(line));
  integrationConfiguration({ OPENAI_API_KEY: 'secret-model-value', RESEND_API_KEY: 'secret-mail-value',
    EMAIL_FROM: 'private-fixture@example.test', TBANK_ENABLED: 'true', TBANK_TERMINAL_KEY: 'secret-terminal-value',
    TBANK_PASSWORD_BASE64: 'secret-bank-value' });
  const data = JSON.parse(lines[0]);
  assert.equal(data.providerAvailability, 'not_checked');
  assert.equal(data.modelKeyConfigured, true);
  assert.equal(data.mailConfigured, true);
  assert.equal(data.bankCredentialsConfigured, true);
  assert.doesNotMatch(lines.join(''), /secret-|private-fixture/);
  assert.equal(safeErrorCode({ code: 'EACCES', message: 'secret-error-value' }), 'EACCES');
  assert.equal(safeErrorCode({ code: 'secret-error-value' }), 'UNKNOWN');
});

test('Health probes close connections so monitoring does not occupy detector concurrency slots', async t => {
  let calls=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    calls++;
    assert.equal(options.headers.Connection,'close');
    if(String(url).includes('8100')) {
      assert.equal(options.headers.Authorization,'Bearer fixture-health-token');
      return new Response('private-fixture-error',{status:503});
    }
    return Response.json({status:'ready'});
  });
  const state=await serviceStatus({piiEnv:{PII_ANALYZER_TOKEN:'fixture-health-token'},siteHealth:'http://127.0.0.1:3000/api/health'});
  assert.equal(calls,2);assert.equal(state.pii.status,'unavailable');assert.equal(state.site.status,'ready');
  assert.doesNotMatch(JSON.stringify(state),/private-fixture|fixture-health-token/);
});
