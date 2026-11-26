import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createTestApp } from './node-app.mjs';

const monitor = 'synthetic-monitor-secret-for-health-tests';
const detector = 'synthetic-detector-secret-for-health-tests';
let piiCalls = 0, mailCalls = 0, outcome = 'ready';
const unexpected = [];
const app = await createTestApp({
  bindings: {
    MONITORING_TOKEN: monitor, PII_ANALYZER_URL: 'http://127.0.0.1:8100/analyze', PII_ANALYZER_TOKEN: detector,
    OPENAI_API_KEY: 'synthetic-model-credential', RESEND_API_KEY: 'synthetic-mail-credential', EMAIL_FROM: 'Criterion <server@example.test>',
    TBANK_ENABLED:'true', TBANK_TERMINAL_KEY:'TESTDEMO', TBANK_PASSWORD:'test-only', TBANK_RECEIPT_MODE:'external', TBANK_PUBLIC_URL:'https://criterion.test',
    LOG_LEVEL:'error',
  },
  fetchMock:{ async dispatch(message) {
    if (message.url === 'http://127.0.0.1:8100/health' && message.method === 'GET' &&
        message.headers.authorization === 'Bearer '+detector && message.body === '') {
      piiCalls++;
      if (outcome === 'timeout') await delay(1800);
      return {status:outcome === 'down'?503:200, body:JSON.stringify({ status:'ready' }), headers:{'content-type':'application/json'}};
    }
    if (message.url === 'https://api.resend.com/emails' && message.method === 'POST') {
      mailCalls++;
      return {status:200,body:JSON.stringify({id:'d9159e5e-b302-468b-aad2-e5256b162c0c'}),headers:{'content-type':'application/json'}};
    }
    unexpected.push(message.method); throw new Error('unexpected external or mutating probe');
  }},
});
const get = (path, headers) => app.dispatchFetch('https://criterion.test/api/health/'+path, {headers});
const auth = { authorization: 'Bearer '+monitor };
try {
  for (const variant of [{}, {authorization:'Bearer '+detector}, {authorization:'Bearer invalid'}]) {
    const response = await get('integrations?token='+monitor, variant);
    assert.equal(response.status,401);
    const body = await response.json();
    assert.ok(!('components' in body));
  }
  assert.deepEqual(await (await get('live')).json(),{status:'ok'});
  assert.equal(piiCalls,0);
  const results = await Promise.all(Array.from({length:8}, () => get('ready')));
  assert.ok(results.every(response => response.status===200));
  assert.deepEqual(await results[0].json(),{status:'ready'});
  const first = await (await get('integrations',auth)).json();
  assert.equal(piiCalls,1);
  assert.equal(first.components.sqlite.functional,true);
  assert.equal(first.components.piiDetector.reachable,true);
  assert.equal(first.components.piiDetector.functional,'unknown');
  for (const name of ['ai','resend','bank','paymentGateway']) {
    assert.equal(first.components[name].lastCheckedAt,null);
    assert.equal(first.components[name].reachable,'unknown');
    assert.equal(first.components[name].functional,'unknown');
  }
  assert.equal(first.components.resend.configured,true);
  assert.equal(first.components.bank.configured,true);
  assert.equal(mailCalls,0);
  const registration = await app.dispatchFetch('https://criterion.test/api/auth',{ method:'POST',
    headers:{Origin:'https://criterion.test','content-type':'application/json'},
    body:JSON.stringify({action:'register',email:'probe-fixture@example.test',password:'Synthetic-Monitoring-2026'}) });
  assert.equal(registration.status,200); assert.equal((await registration.json()).verificationSent,true);
  const next = await (await get('integrations',auth)).json();
  assert.equal(next.components.resend.functional,true);
  assert.equal(mailCalls,1);

  for (const failure of ['down','timeout']) {
    outcome = failure;
    await delay(2100);
    const unavailable = await get('ready');
    assert.equal(unavailable.status,503, failure);
    assert.deepEqual(await unavailable.json(),{status:'unavailable'});
    assert.equal((await get('live')).status,200);
    const status = await (await get('integrations',auth)).json();
    assert.equal(status.components.piiDetector.reachable,failure === 'down');
    assert.equal(status.components.piiDetector.functional,false);
  }
  outcome = 'ready';
  const db = app.database();
  const last = db.prepare('SELECT name FROM _criterion_migrations ORDER BY name DESC LIMIT 1').first();
  db.prepare('DELETE FROM _criterion_migrations WHERE name=?').bind(last.name).run();
  await delay(2100);
  assert.equal((await get('ready')).status,503);
  const badSchema = await (await get('integrations',auth)).json();
  assert.equal(badSchema.components.sqlite.reachable,true);
  assert.equal(badSchema.components.sqlite.functional,false);
  assert.equal(db.prepare('SELECT name FROM _criterion_migrations WHERE name=?').bind(last.name).first(),null);
  assert.equal((await get('live')).status,200);
  assert.deepEqual(unexpected,[]);
  for (const marker of [monitor,detector,'probe-fixture@example.test','synthetic-model-credential','synthetic-mail-credential']) {
    assert.ok(!app.logs().includes(marker)); assert.ok(!JSON.stringify(next).includes(marker));
  }
  console.log('Health checks passed: live, readiness, deadlines, concurrent cache, read-only schema check, private access, passive providers.');
} finally { await app.dispose(); }
