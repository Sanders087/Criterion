import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTestApp, createFetchMock } from './node-app.mjs';

const provider = createFetchMock();
const text = 'fixture-secret-contract-contents';
provider.get('https://pii.test').intercept({path:'/analyze',method:'POST'}).reply(200,
  JSON.stringify({ profile:'ru-contract-v1',offsetUnit:'utf16',spans:[] })).persist();
provider.get('https://api.openai.com').intercept({path:'/v1/chat/completions',method:'POST'}).reply(200,
  JSON.stringify({choices:[{message:{content:JSON.stringify({reply:text,facts:{},ready:false})},finish_reason:'stop'}]}));
const site = await createTestApp({fetchMock:provider, bindings:{OPENAI_API_KEY:'synthetic',PII_ANALYZER_URL:'https://pii.test/analyze',
  PII_ANALYZER_TOKEN:'synthetic-detector-credential-123456789'}});
try {
  const db = site.database(), session = 'c'.repeat(64), owner = 'qa-save';
  db.prepare('INSERT INTO accounts (id,email,password_hash,salt,recovery_hash,created_at) VALUES (?,?,?,?,?,?)')
    .bind(owner,'save-fixture@example.test','dummy','dummy','dummy',Date.now()).run();
  db.prepare('INSERT INTO sessions(token_hash,account_id,expires_at) VALUES (?,?,?)')
    .bind(createHash('sha256').update(session).digest('hex'),owner,Date.now()+60000).run();
  const headers = {Origin:'https://criterion.test',cookie:'__Host-criterion_session='+session,'content-type':'application/json'};
  const created = await site.dispatchFetch('https://criterion.test/api/documents',{method:'POST',headers,
    body:JSON.stringify({kind:'services',mode:'ai'})});
  assert.equal(created.status,201);
  const doc = await created.json();
  db.prepare("CREATE TRIGGER test_save_failure BEFORE UPDATE OF revision ON documents BEGIN SELECT RAISE(ABORT,'synthetic-save-failure'); END").run();
  const response = await site.dispatchFetch('https://criterion.test/api/documents/'+doc.id,{method:'PATCH',headers,
    body:JSON.stringify({action:'message',revision:doc.revision,text})});
  const failure = await response.json();
  assert.equal(response.status,500);
  assert.equal(failure.code,'DOCUMENT_SAVE_FAILED');
  const row = db.prepare('SELECT revision,body,lock_token FROM documents WHERE id=?').bind(doc.id).first();
  assert.equal(row.revision,doc.revision);
  assert.equal(row.lock_token,null);
  assert.ok(!row.body.includes(text));
  const events = site.logs().split('\n').filter(line => line.startsWith('{')).map(line=>JSON.parse(line))
    .filter(e=>e.requestId===failure.requestId);
  const done = events.find(e=>e.event==='ai.request_completed'), save = events.find(e=>e.event==='document.revision_save_failed');
  assert.ok(done?.operationId && save?.operationId);
  assert.equal(done.operationId,save.operationId);
  assert.ok(!events.some(e=>e.event==='document.revision_saved'));
  assert.ok(!site.logs().includes(text));
  console.log('A validated model reply followed by a SQLite save failure retained one trace and the previous revision.');
} finally { await site.dispose(); }
