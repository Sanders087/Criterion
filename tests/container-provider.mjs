// Mounted ONLY by container-e2e.mjs. This file is absent from the production image.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const fixture = JSON.parse(readFileSync('/app/tests/fixtures/pii-office-services-case.json', 'utf8'));
const originalFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init), url = new URL(request.url);
  if (request.method === 'GET' && request.url === 'http://127.0.0.1:8100/health') return originalFetch(request);
  if (url.origin === 'http://127.0.0.1:8100' && url.pathname === '/analyze') {
    if (existsSync('/tmp/fixture-detector-failure')) return new Response('{}', { status: 503 });
    return originalFetch(request);
  }
  if (request.url !== 'https://api.openai.com/v1/chat/completions') throw new Error('Unmocked external request');
  const body = await request.json(), serialized = JSON.stringify(body);
  for (const span of fixture.sensitive) assert.ok(!serialized.includes(span.text), 'PII leaked into model request');
  assert.match(serialized, /CRITERION_PII/);
  calls++; writeFileSync('/tmp/fixture-model-calls', String(calls));
  const data = JSON.parse(body.messages[1].content);
  const source = data.messages?.find(item => item.role === 'user')?.text || data.sections?.[0]?.content || Object.values(data.facts || {}).join(' ');
  const value = body.messages[0].content.includes('Режим интервью') ? { reply: source, facts: {}, ready: true }
    : data.expectedSections ? { sections: data.expectedSections.map((section, index) => ({ ...section, content: index === 0 ? (source || 'Тестовое условие.') : 'Согласованное условие ' + section.id + '.' })), issues: [] }
    : { issues: [{ id: 'checked', severity: 'info', title: 'Проверено', detail: 'Условия проверены в тесте.' }] };
  return Response.json({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] });
};
