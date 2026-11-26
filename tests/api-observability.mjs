import assert from 'node:assert/strict';
import { createTestApp } from './node-app.mjs';

const app = await createTestApp({});
try {
  const spoof = 'r_00000000-0000-4000-8000-000000000000';
  const requests = [
    ['/api/health', {}, 200],
    ['/api/documents/private-fixture-id/export?secret=hidden-fixture', {}, 401],
    ['/api/auth', { method: 'POST', headers: { Origin:'https://criterion.test','Content-Type':'application/json' },
      body:'{invalid-secret-fixture' }, 400],
  ];
  const responses = await Promise.all(requests.map(([path, init]) => app.dispatchFetch('https://criterion.test' + path,
    { ...init, headers: { ...init.headers, 'X-Request-ID':spoof } })));
  const ids = new Set();
  for (const [index, response] of responses.entries()) {
    const id = response.headers.get('X-Request-ID');
    assert.match(id, /^r_[0-9a-f-]{36}$/);
    assert.notEqual(id, spoof);
    ids.add(id);
    assert.equal(response.status, requests[index][2]);
    const body = await response.json();
    if (response.ok) assert.deepEqual(body, {status:'ready'});
    else {
      assert.equal(body.requestId, id);
      assert.equal(body.code, index === 1 ? 'UNAUTHORIZED' : 'BAD_REQUEST');
    }
    const events = app.logs().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    const terminal = events.filter(e => e.requestId === id && e.event !== 'http.request_started');
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].httpStatus, response.status);
    assert.ok(terminal[0].durationMs >= 0);
    if (index === 1) assert.equal(terminal[0].route, '/api/documents/[id]/export');
  }
  assert.equal(ids.size, 3);
  for (const [path, allowed] of [['/api/auth', 'GET, HEAD, OPTIONS, POST'], ['/api/documents','OPTIONS, POST']]) {
    const options = await app.dispatchFetch('https://criterion.test' + path, {method:'OPTIONS'});
    assert.equal(options.status, 204);
    assert.equal(options.headers.get('Allow'), allowed);
    assert.match(options.headers.get('X-Request-ID'), /^r_[0-9a-f-]{36}$/);
    const badMethod = await app.dispatchFetch('https://criterion.test' + path, {method:'DELETE'});
    assert.equal(badMethod.status, 405);
    assert.equal(badMethod.headers.get('Allow'), allowed);
    const payload = await badMethod.json();
    assert.equal(payload.code, 'METHOD_NOT_ALLOWED');
    assert.equal(payload.requestId, badMethod.headers.get('X-Request-ID'));
    const head = await app.dispatchFetch('https://criterion.test' + path, {method:'HEAD'});
    assert.equal(head.status, allowed.includes('HEAD') ? 200 : 405);
    assert.match(head.headers.get('X-Request-ID'), /^r_[0-9a-f-]{36}$/);
    assert.equal(await head.text(), '');
  }
  assert.doesNotMatch(app.logs(), /private-fixture|hidden-fixture|invalid-secret-fixture|00000000-0000/);
  console.log('API observability verified on real HTTP routes, concurrent requests and errors.');
} finally { await app.dispose(); }
