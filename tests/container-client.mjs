// Runs in an isolated test container, never in a deployed service.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
const base = 'http://127.0.0.1:3000';
const fixture = JSON.parse(readFileSync('/test/fixtures/pii-office-services-case.json', 'utf8'));
let cookie = '';
async function api(path, method = 'GET', body, status = 200) {
  const response = await fetch(base + path, { method, headers: { cookie, Origin: 'https://criterion.test',
    ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value));
  if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return value;
}
if (process.argv.includes('--persisted')) {
  const saved = JSON.parse(readFileSync('/data/fixture-session.json', 'utf8')); cookie = saved.cookie;
  const doc = await api('/api/documents/' + saved.id);
  assert.equal(doc.id, saved.id); assert.equal(doc.revision, saved.revision);
  assert.ok(doc.sections[0].content.includes(fixture.sensitive[0].text));
  console.log('Container restart: account, session, document and restored PII persisted.');
} else {
  assert.equal((await api('/api/health')).status, 'ready');
  const pythonPid = readdirSync('/proc').filter(name => /^\d+$/.test(name)).find(name => {
    try { return readFileSync('/proc/' + name + '/cmdline', 'utf8').includes('services.pii.app:create_app'); } catch { return false; }
  });
  assert.ok(pythonPid);
  const pythonEnv = readFileSync('/proc/' + pythonPid + '/environ', 'utf8').split('\0');
  for (const secret of ['OPENAI_API_KEY', 'DATABASE_PATH', 'RESEND_API_KEY', 'TBANK_PASSWORD']) assert.ok(!pythonEnv.some(item => item.startsWith(secret + '=')));
  assert.equal((await fetch(base + '/analyze')).status, 404);
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/auth')).status, 200);
  await api('/api/auth', 'POST', { action: 'register', email: 'docker@example.test', password: 'Synthetic-Docker-Password-2026' });
  let doc = await api('/api/documents', 'POST', { kind: 'services', mode: 'ai' }, 201);
  const path = '/api/documents/' + doc.id;
  // Grant ONLY this isolated fixture pre-billing access. No payment bypass exists in the app.
  const { openDatabase } = await import('/app/db/sqlite.mjs');
  const database = openDatabase(process.env.DATABASE_PATH);
  database.prepare("UPDATE documents SET billing_state='legacy' WHERE id=?").bind(doc.id).run(); database.close();
  doc = await api(path, 'PATCH', { action: 'message', revision: doc.revision, text: fixture.text });
  assert.equal(doc.messages.at(-1).text, fixture.text);
  doc = await api(path, 'PATCH', { action: 'generate', revision: doc.revision });
  assert.ok(doc.sections.length >= 3); assert.ok(doc.sections[0].content.includes(fixture.sensitive[0].text));
  doc = await api(path, 'PATCH', { action: 'revise', revision: doc.revision, text: 'Сохраните согласованные условия.' });
  doc = await api(path, 'PATCH', { action: 'review', revision: doc.revision });
  assert.ok(!JSON.stringify(doc).includes('CRITERION_PII'));
  const exported = await fetch(base + path + '/export?format=docx', { headers: { cookie } });
  assert.equal(exported.status, 200); assert.equal(new DataView(await exported.arrayBuffer()).getUint32(0, true), 0x04034b50);
  assert.equal(Number(readFileSync('/tmp/fixture-model-calls', 'utf8')), 6);
  writeFileSync('/tmp/fixture-detector-failure', '1');
  await api(path, 'PATCH', { action: 'revise', revision: doc.revision, text: 'Ещё одно уточнение.' }, 500);
  assert.equal((await api(path)).revision, doc.revision);
  assert.equal(Number(readFileSync('/tmp/fixture-model-calls', 'utf8')), 6);
  writeFileSync('/data/fixture-session.json', JSON.stringify({ cookie, id: doc.id, revision: doc.revision }));
  console.log('Container E2E passed: real site + SQLite + Python, 6 masked model calls, restoration, DOCX, fail-closed rollback.');
}
