import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { AppError, normalizeError, technicalCause } from '../lib/criterion/app-error.ts';
import { apiRoute, observeOperation } from '../lib/criterion/api-observability.ts';
import { getRequestContext } from '../lib/request-context.mjs';

test('HTTP replies and terminal logs correlate under concurrency without echoing caller IDs or exceptions', async t => {
  const logs: string[] = [];
  for (const name of ['log', 'warn', 'error'] as const) t.mock.method(console, name, (line: string) => logs.push(line));
  const secret = 'ИИ secret-fixture@example.test';
  const inner = Object.assign(new Error(secret), { code: 'ENOTFOUND' });
  const handler = apiRoute('/api/documents/[id]', async (request: Request) => {
    const before = getRequestContext()!.requestId;
    await delay(5);
    assert.equal(getRequestContext()!.requestId, before);
    if (request.method === 'PATCH') {
      return observeOperation('ai', 'generation', async () => {
        await delay(5);
        throw new Error(secret, { cause: inner });
      });
    }
    return Response.json({ ok: true });
  });
  const responses = await Promise.all(['GET', 'PATCH'].map(method => handler(new Request(
    'https://fixture.test/api/documents/private-fixture-id?q=private-fixture-query', {
      method, headers: {'X-Request-ID': 'r_00000000-0000-4000-8000-000000000000'} }))));
  const ids = responses.map(response => response.headers.get('X-Request-ID'));
  assert.equal(new Set(ids).size, 2);
  for (const id of ids) {
    assert.match(id!, /^r_[0-9a-f-]{36}$/);
    assert.notEqual(id, 'r_00000000-0000-4000-8000-000000000000');
  }
  assert.equal(responses[0].status, 200);
  assert.equal(responses[1].status, 500);
  const body = await responses[1].json();
  assert.equal(body.requestId, ids[1]);
  assert.equal(body.code, 'INTERNAL_ERROR');
  const events = logs.map(line => JSON.parse(line));
  assert.equal(events.filter(e => e.event === 'http.request_started').length, 2);
  assert.equal(events.find(e => e.event === 'http.request_completed').requestId, ids[0]);
  const failed = events.filter(e => e.event === 'http.request_failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].requestId, ids[1]);
  assert.equal(failed[0].route, '/api/documents/[id]');
  assert.equal(failed[0].causeCode, 'ENOTFOUND');
  const op = events.find(e => e.event === 'operation.started');
  assert.match(op.operationId, /^o_[0-9a-f-]{36}$/);
  assert.equal(op.operationId, failed[0].operationId);
  assert.doesNotMatch(logs.join('') + JSON.stringify(body), /fixture@example|private-fixture|00000000-0000|Error: ИИ/);
});

test('error normalization preserves trusted metadata, bounds cause traversal and separates validation and timeout', () => {
  const typed = new AppError({code:'MAIL_SEND_FAILED', status:503, publicMessage:'Письмо не отправлено.',
    service:'mail',stage:'provider_request',cause:new Error('fixture')});
  assert.equal(normalizeError(typed), typed);
  const cyclic = Object.assign(new Error('fixture'), { code: 'private-value', cause: {} });
  cyclic.cause = cyclic;
  assert.equal(technicalCause(cyclic), undefined);
  let deep = Object.assign(new Error(), {code:'ECONNREFUSED'});
  for (let i = 0; i < 5; i++) deep = Object.assign(new Error('', {cause:deep}), {code:'unknown'});
  assert.equal(technicalCause(deep), undefined);
  assert.equal(normalizeError(z.string().safeParse(12).error).code, 'VALIDATION_ERROR');
  const timeout = normalizeError(new DOMException('secret API cause', 'TimeoutError'));
  assert.equal(timeout.code, 'REQUEST_TIMEOUT');
  assert.doesNotMatch(timeout.publicMessage, /ИИ|secret/);
});
