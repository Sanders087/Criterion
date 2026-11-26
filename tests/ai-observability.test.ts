import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../lib/criterion/app-error.ts';
import { interview } from '../lib/criterion/ai.ts';
import { protectRequest } from '../lib/criterion/privacy.ts';
import { trustedDetector } from '../lib/criterion/privacy-detector.ts';
import { makeContract, EMPTY_MATERIALS } from '../lib/criterion/domain.ts';

const detectUrl = 'https://pii.test/analyze';
const runtime = { PII_ANALYZER_TOKEN: 'only-synthetic-test-token-used-here', PII_ANALYZER_URL: detectUrl,
  OPENAI_API_KEY: 'private-model-token', OPENAI_MODEL: 'gpt-4.1' };
const fixture = 'synthetic.person@example.test';
const doc = makeContract('services','ai');
doc.facts.partyA = fixture;
const clean = () => Response.json({profile:'ru-contract-v1',offsetUnit:'utf16',spans:[]});
const failsWith = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;

test('Detector failures retain their stage, use bounded metadata, and stop the provider request', async t => {
  const lines: string[] = [];
  for (const method of ['log','error'] as const) t.mock.method(console, method, (line: string) => lines.push(line));
  const cases: [string, () => Response][] = [
    ['PII_TIMEOUT', () => { throw new DOMException(fixture,'TimeoutError'); }],
    ['PII_RESPONSE_TOO_LARGE', () => new Response('x'.repeat(2_000_001))],
    ['PII_HTTP_ERROR', () => new Response(fixture,{status:403})],
    ['PII_RESPONSE_INVALID', () => new Response(fixture)],
    ['PII_SPAN_INVALID', () => Response.json({profile:'ru-contract-v1',offsetUnit:'utf16',spans:[{textIndex:-1}]})],
  ];
  for (const [code, response] of cases) {
    const mock = t.mock.method(globalThis, 'fetch', async (url: string) => { assert.equal(String(url),detectUrl); return response(); });
    await assert.rejects(interview(runtime, doc, EMPTY_MATERIALS), failsWith(code));
    assert.equal(mock.mock.callCount(), 1);
    mock.mock.restore();
  }
  await assert.rejects(protectRequest({instruction:'',data:'[[CRITERION_PII_foreign]]'},trustedDetector(runtime)),failsWith('PII_RESERVED_MARKER'));
  await assert.rejects(protectRequest({instruction:'',data:'x'.repeat(500_001)},trustedDetector(runtime)),failsWith('PII_INPUT_LIMIT'));
  await assert.rejects(protectRequest({instruction:'',data:''},trustedDetector({})),failsWith('PII_CONFIG_INVALID'));
  assert.ok(lines.some(line => JSON.parse(line).event === 'pii.stage_failed'));
  assert.ok(lines.every(line => !line.includes(fixture) && !line.includes('CRITERION_PII_foreign')));
});

test('Provider metadata is allowlisted, schema/HTTP/timeout failures remain distinguishable', async t => {
  const logs: string[] = [];
  for (const method of ['log','error'] as const) t.mock.method(console,method,(line: string) => logs.push(line));
  const id = 'req_' + 'a'.repeat(32);
  const completion = (reply: unknown, reason = 'stop') => Response.json({
    choices:[{message:{content:JSON.stringify(reply)},finish_reason:reason}],
    usage:{prompt_tokens:20,completion_tokens:10}, ignored:fixture,
  }, {headers:{'x-request-id':id}});
  const cases: [string, () => Response][] = [
    ['AI_NETWORK_ERROR',()=>{throw Error(fixture);}], ['AI_TIMEOUT',()=>{throw new DOMException(fixture,'TimeoutError');}],
    ['AI_AUTH_FAILED',()=>new Response(fixture,{status:401})], ['AI_RATE_LIMITED',()=>new Response(fixture,{status:429})],
    ['AI_PROVIDER_ERROR',()=>new Response(fixture,{status:503})], ['AI_OUTPUT_TRUNCATED',()=>completion({},'length')],
    ['AI_RESPONSE_INVALID',()=>new Response(fixture)], ['AI_SCHEMA_VALIDATION_FAILED',()=>completion({wrong:fixture})],
  ];
  for (const [code, reply] of cases) {
    const mock = t.mock.method(globalThis,'fetch',async (url: string) => String(url)===detectUrl ? clean() : reply());
    await assert.rejects(interview(runtime,doc,EMPTY_MATERIALS),failsWith(code)); mock.mock.restore();
  }
  t.mock.method(globalThis,'fetch',async (url: string) => String(url)===detectUrl ? clean() : completion({reply:'ok',facts:{},ready:true}));
  await interview(runtime,doc,EMPTY_MATERIALS);
  const events = logs.map(line=>JSON.parse(line));
  const event = events.filter(e=>e.event==='ai.request_completed').at(-1);
  assert.equal(event.providerRequestId,id); assert.equal(event.model,'gpt-4.1');
  assert.equal(event.inputTokens,20); assert.equal(event.outputTokens,10); assert.equal(event.finishReason,'stop');
  assert.ok(events.some(e=>e.event==='ai.response_validation_failed' && e.schemaValid===false));
  assert.ok(logs.every(line => !line.includes(fixture) && !line.includes(runtime.OPENAI_API_KEY) && !line.includes(runtime.PII_ANALYZER_TOKEN)));
});
