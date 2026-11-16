import test from 'node:test';
import assert from 'node:assert/strict';
import { protectRequest, PrivacyError, type PiiDetector, type PiiSpan } from '../lib/criterion/privacy.ts';
import { trustedDetector } from '../lib/criterion/privacy-detector.ts';

const none: PiiDetector = async () => ({ profile: 'ru-contract-v1', offsetUnit: 'utf16', spans: [] });
const find = (...values: string[]): PiiDetector => async (texts) => {
  const spans: PiiSpan[] = [];
  texts.forEach((text, textIndex) => {
    for (const value of values) {
      let start = text.indexOf(value);
      while (start >= 0) {
        spans.push({ textIndex, start, end: start + value.length, entityType: 'PERSON' });
        start = text.indexOf(value, start + value.length);
      }
    }
  });
  return { profile: 'ru-contract-v1', offsetUnit: 'utf16', spans };
};
const tokens = (value: unknown) => JSON.stringify(value).match(/\[\[CRITERION_PII_[A-Za-z0-9_]+\]\]/g) || [];

test('Nested values, keys and system instruction round-trip without changing source', async () => {
  const input = { instruction: 'Иванов Иван: инструкция', data: {
    'Иванов Иван': ['😀 Иванов Иван', { name: 'Иванов Иван', value: 45_000, omitted: undefined }],
  } };
  const before = JSON.stringify(input);
  const result = await protectRequest(input, find('Иванов Иван'));
  assert.doesNotMatch(JSON.stringify(result.payload), /Иванов/);
  assert.equal(new Set(tokens(result.payload)).size, 1);
  assert.equal(JSON.stringify(result.restore(result.payload)), before);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(Object.keys(result).sort(), ['payload', 'restore']);
});

test('Known party and requisite values are always protected and replaced across fields', async () => {
  const input = { instruction: 'rules', data: {
    facts: { partyA: 'ИП Тестовый Иван', detailsA: 'Редкий идентификатор АБ-Ж-123' },
    context: 'Адресат ИП Тестовый Иван, Редкий идентификатор АБ-Ж-123',
    price: '45 000 рублей', term: '01.12.2026',
  } };
  const result = await protectRequest(input, none);
  assert.doesNotMatch(JSON.stringify(result.payload), /Тестовый|АБ-Ж/);
  assert.match(JSON.stringify(result.payload), /45 000 рублей|01.12.2026/);
  assert.deepEqual(result.restore(result.payload), input);
});

test('False-positive NER cannot rename application schema or enum identifiers', async () => {
  const input = { instruction: '', data: { kind: 'services', expectedSections: [],
    facts: { partyA: 'Иванов' }, allowedFields: [{ key: 'partyA' }],
    messages: [{ role: 'user', text: 'Иванов' }] } };
  const result = await protectRequest(input, find('expectedSections', 'partyA', 'services', 'user', 'Иванов'));
  const data = result.payload.data as typeof input.data;
  assert.deepEqual(data.expectedSections, []);
  assert.equal(data.allowedFields[0].key, 'partyA');
  assert.equal(data.kind, 'services');
  assert.equal(data.messages[0].role, 'user');
  assert.doesNotMatch(JSON.stringify(data), /Иванов/);
  assert.deepEqual(result.restore(result.payload), input);
});

test('Overlapping spans are unioned without leaking tails; adjacent spans stay separate', async () => {
  const text = 'Иванов Иван Петрович;AB';
  const result = await protectRequest({ instruction: '', data: text }, async (texts) => ({
    profile: 'ru-contract-v1', offsetUnit: 'utf16',
    spans: [
      { textIndex: texts.indexOf(text), start: 0, end: 11, entityType: 'PERSON' },
      { textIndex: texts.indexOf(text), start: 7, end: 19, entityType: 'PERSON' },
      { textIndex: texts.indexOf(text), start: 20, end: 21, entityType: 'VALUE' },
      { textIndex: texts.indexOf(text), start: 21, end: 22, entityType: 'VALUE' },
    ],
  }));
  assert.equal(tokens(result.payload.data).length, 3);
  assert.doesNotMatch(String(result.payload.data), /Петрович/);
  assert.equal(result.restore(result.payload.data), text);
});

test('Scopes are random and foreign tokens cannot restore another request', async () => {
  const a = await protectRequest({ instruction: '', data: 'Иванов' }, find('Иванов'));
  const b = await protectRequest({ instruction: '', data: 'Иванов' }, find('Иванов'));
  assert.notEqual(a.payload.data, b.payload.data);
  assert.throws(() => b.restore(a.payload.data), PrivacyError);
});

test('Exact source forms are restored without guessed declension or value normalization', async () => {
  const text = 'Иванов Иван; Иванову Ивану; +7 (900) 000-00-00';
  const result = await protectRequest({ instruction: '', data: text },
    find('Иванов Иван', 'Иванову Ивану', '+7 (900) 000-00-00'));
  assert.equal(result.restore(result.payload.data), text);
  assert.equal(new Set(tokens(result.payload.data)).size, 3);
});

test('Unknown, truncated, lowercased or changed tokens stop restoration', async () => {
  const result = await protectRequest({ instruction: '', data: 'Иванов' }, find('Иванов'));
  const token = result.payload.data as string;
  for (const changed of [token.slice(0, -1), token.toLowerCase(), token.replace('CRITERION', 'CRI TERION'), token.replace('CRITERION', 'CRI\u200bTERION'), token.replace('_1]]', '_999]]')]) {
    assert.throws(() => result.restore({ reply: changed }), PrivacyError);
  }
});

test('Input cannot inject reserved tokens or use a malformed Unicode surrogate', async () => {
  for (const text of ['[[CRITERION_PII_guess_PERSON_1]]', 'criterion_pii_fake', '\ud800']) {
    await assert.rejects(() => protectRequest({ instruction: '', data: text }, none), PrivacyError);
  }
});

test('Malformed detector results, invalid offsets and split surrogate spans fail closed', async () => {
  const input = { instruction: '', data: '😀Иванов' };
  for (const invalid of [
    null, { profile: 'wrong', offsetUnit: 'utf16', spans: [] },
    { profile: 'ru-contract-v1', offsetUnit: 'codepoint', spans: [] },
  ]) {
    await assert.rejects(() => protectRequest(input, async () => invalid as never), PrivacyError);
  }
  for (const fields of [
    { start: -1, end: 3 }, { start: 0, end: 100 }, { start: 2, end: 2 },
    { start: 0.5, end: 2 }, { start: 1, end: 3 },
  ]) {
    await assert.rejects(() => protectRequest(input, async texts => ({
      profile: 'ru-contract-v1', offsetUnit: 'utf16',
      spans: [{ textIndex: texts.indexOf(input.data), entityType: 'PERSON', ...fields }],
    })), PrivacyError);
  }
});

test('Detector failures never expose raw exception text', async () => {
  await assert.rejects(() => protectRequest({ instruction: '', data: 'secret' },
    async () => { throw new Error('raw secret Иванов'); }),
  error => error instanceof PrivacyError && !/secret|Иванов/.test(error.message));
});

test('Huge input and cyclic input stop before invoking the detector', async () => {
  let calls = 0;
  const detect: PiiDetector = async texts => { calls++; return none(texts); };
  await assert.rejects(() => protectRequest({ instruction: '', data: 'x'.repeat(500_001) }, detect), PrivacyError);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  await assert.rejects(() => protectRequest({ instruction: '', data: cyclic }, detect), PrivacyError);
  assert.equal(calls, 0);
});

test('Prototype-named JSON keys are treated as data, never as prototype writes', async () => {
  const input = { instruction: '', data: JSON.parse('{"__proto__":{"name":"Иванов"}}') };
  const result = await protectRequest(input, find('Иванов'));
  assert.equal(JSON.stringify(result.restore(result.payload)), JSON.stringify(input));
  assert.equal(Object.prototype.hasOwnProperty.call(result.payload.data, '__proto__'), true);
  assert.equal(({} as { name?: string }).name, undefined);
});

test('Restoration rejects duplicate object keys after substitution', async () => {
  const result = await protectRequest({ instruction: '', data: 'Иванов' }, find('Иванов'));
  assert.throws(() => result.restore({ [result.payload.data as string]: 1, Иванов: 2 }), PrivacyError);
});

test('Repeated tokens cannot inflate the restored response without a bound', async () => {
  const result = await protectRequest({ instruction: '', data: { facts: { partyA: 'x'.repeat(400_000) } } }, none);
  const token = tokens(result.payload.data)[0];
  assert.ok(token);
  assert.throws(() => result.restore(token.repeat(6)), PrivacyError);
});

test('Missing configuration and unsafe endpoint stop before any fetch', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected network'); };
  try {
    for (const config of [
      {}, { PII_ANALYZER_URL: 'http://external.test/analyze', PII_ANALYZER_TOKEN: 'x'.repeat(32) },
      { PII_ANALYZER_URL: 'https://user:pass@pii.test/analyze', PII_ANALYZER_TOKEN: 'x'.repeat(32) },
      { PII_ANALYZER_URL: 'https://pii.test/analyze?text=secret', PII_ANALYZER_TOKEN: 'x'.repeat(32) },
    ]) await assert.rejects(() => trustedDetector(config)(['Иванов']), PrivacyError);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('Trusted HTTP detector disables redirects, sets deadline and validates profile downstream', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:8100/analyze');
    assert.equal(options?.redirect, 'manual');
    assert.ok(options?.signal);
    assert.deepEqual(JSON.parse(options?.body as string), { texts: ['Иванов'] });
    return Response.json({ profile: 'ru-contract-v1', offsetUnit: 'utf16', spans: [] });
  };
  try {
    const result = await trustedDetector({ PII_ANALYZER_URL: 'http://127.0.0.1:8100/analyze',
      PII_ANALYZER_TOKEN: 'x'.repeat(32) })(['Иванов']);
    assert.equal(result.profile, 'ru-contract-v1');
  } finally { globalThis.fetch = original; }
});

test('Untrusted error and oversized analyzer body are discarded', async () => {
  const original = globalThis.fetch;
  try {
    for (const response of [new Response(null, { status: 307, headers: { Location: 'https://untrusted.test/analyze' } }), new Response('Иванов secret', { status: 503 }), new Response('x'.repeat(2_000_001))]) {
      globalThis.fetch = async () => response;
      await assert.rejects(() => trustedDetector({
        PII_ANALYZER_URL: 'https://pii.test/analyze', PII_ANALYZER_TOKEN: 'x'.repeat(32),
      })(['Иванов']), error => error instanceof PrivacyError && !error.message.includes('Иванов'));
    }
  } finally { globalThis.fetch = original; }
});
