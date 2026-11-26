import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createTestApp } from './node-app.mjs';
const token = randomBytes(32).toString('hex');
const app = await createTestApp({bindings:{MONITORING_TOKEN:token, LOG_LEVEL:'error'}});
try {
  const address = app.origin + '/api/metrics';
  for (const key of ['',token.slice(1)]) {
    const blocked = await fetch(address,{headers:{authorization:'Bearer '+key}});
    assert.ok([401,403,404].includes(blocked.status));
    assert.ok(!(await blocked.text()).includes('storage_free_bytes'));
  }
  const db = app.database();
  db.prepare(`INSERT INTO documents(id,owner,title,kind,stage,body,created_at,updated_at,billing_state)
    VALUES ('existing','test-owner','fixture','services','ready','{}','now','now','unpaid')`).run();
  for (const id of ['existing','deleted-after-payment']) {
    db.prepare(`INSERT INTO payment_orders(id,document_id,owner,amount,terminal_key,status,status_rank,created_at,updated_at)
      VALUES (?,?,'test-owner',19900,'dummy','CONFIRMED',20,0,0)`).bind(id,id).run();
  }
  await fetch(app.origin+'/api/workspace');
  const response = await fetch(address,{headers:{authorization:'Bearer '+token}});
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type'),/text\/plain/);
  const data = await response.text();
  assert.match(data,/http_requests_total\{route="\/api\/workspace",status="200"\} [1-9]/);
  assert.match(data,/sqlite_available 1\n/);
  assert.match(data,/sqlite_wal_size_bytes [0-9]+\n/);
  assert.match(data,/storage_free_bytes [1-9][0-9]*\n/);
  assert.match(data,/payment_confirmed_without_access 1\n/);
  assert.match(data,/payment_unresolved_orders 1\n/);
  assert.ok(!data.includes(token) && !data.includes('requestId'));
  console.log('Private metrics, active HTTP histograms, storage and payment gauges verified.');
} finally { await app.dispose(); }
