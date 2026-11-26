import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, interview, reviewAI } from '../lib/criterion/ai.ts';
import { makeContract, EMPTY_MATERIALS, type Section } from '../lib/criterion/domain.ts';
import { PrivacyError, type PiiSpan } from '../lib/criterion/privacy.ts';

const runtime = {
  OPENAI_API_KEY: 'fixture-only-not-a-secret',
  OPENAI_MODEL: 'fixture-model',
  PII_ANALYZER_URL: 'https://pii.test/analyze',
  PII_ANALYZER_TOKEN: 'fixture-only-private-analyzer-token',
};
const privateValues = ['Иванов Иван Петрович', 'test-person@example.test', '4510 123456', '+7 (900) 111-22-33'];
const completion = (data: unknown) => Response.json({
  choices: [{ message: { content: JSON.stringify(data) }, finish_reason: 'stop' }],
});

type FixtureData = { facts: Record<string, string>; expectedSections: Section[]; sections: Section[]; requestedChange: string };

async function withGateway(
  respond: (data: FixtureData, providerBody: string, call: number) => Response,
  run: () => Promise<void>,
  analyzerFailure = false,
) {
  const original = globalThis.fetch;
  let providerCalls = 0, analyzerCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url) === runtime.PII_ANALYZER_URL) {
      analyzerCalls++;
      if (analyzerFailure) return new Response('input could appear here', { status: 503 });
      const { texts } = JSON.parse(options?.body as string) as { texts: string[] };
      const spans: PiiSpan[] = [];
      texts.forEach((text, textIndex) => privateValues.forEach(value => {
        for (let start = text.indexOf(value); start >= 0; start = text.indexOf(value, start + value.length)) {
          spans.push({ textIndex, start, end: start + value.length, entityType: 'PERSON' });
        }
      }));
      return Response.json({ profile: 'ru-contract-v1', offsetUnit: 'utf16', spans });
    }
    assert.equal(String(url), 'https://api.openai.com/v1/chat/completions');
    const body = options?.body as string;
    for (const value of privateValues) assert.ok(!body.includes(value), 'PII reached provider');
    assert.ok(!body.includes(runtime.PII_ANALYZER_TOKEN));
    assert.ok(!body.includes('originals'));
    providerCalls++;
    const request = JSON.parse(body);
    assert.match(request.messages[0].content, /защищённые обозначения/);
    return respond(JSON.parse(request.messages[1].content), body, providerCalls);
  };
  try {
    await run();
    return { providerCalls, analyzerCalls };
  } finally { globalThis.fetch = original; }
}

function document() {
  const doc = makeContract('services', 'ai');
  doc.facts = { partyA: privateValues[0], price: '45 000 рублей', detailsA: privateValues[2] };
  doc.context = 'Контакт: ' + privateValues[1];
  doc.messages.push({ id: 'test', role: 'user', text: privateValues.join('; '), at: '2026-11-14' });
  return doc;
}

test('Interview protects full history, facts, context and sources; restores facts and reply', async () => {
  const doc = document(), before = structuredClone(doc);
  const calls = await withGateway(data => completion({
    reply: 'Уточните данные ' + data.facts.partyA, facts: data.facts, ready: false,
  }), async () => {
    const result = await interview(runtime, doc, { ...EMPTY_MATERIALS, sources: privateValues[3] });
    assert.equal(result.facts.partyA, privateValues[0]);
    assert.match(result.reply, /Иванов Иван Петрович/);
    assert.deepEqual(doc, before);
  });
  assert.equal(calls.providerCalls, 1);
  assert.equal(calls.analyzerCalls, 1);
});

test('Generation and its second audit both protect templates, materials and restored draft', async () => {
  const doc = document(), before = structuredClone(doc);
  const template = [
    { id: 'parties', title: 'Стороны', content: privateValues[0] },
    { id: 'price', title: 'Цена', content: '45 000 рублей' },
    { id: 'details', title: 'Реквизиты', content: privateValues[2] },
  ];
  const calls = await withGateway(data => {
    assert.equal(data.facts.price, '45 000 рублей');
    const sections = data.expectedSections.map((s: Section) =>
      ({ ...s, content: s.id === 'parties' ? data.facts.partyA : s.content }));
    return completion({ sections, issues: [] });
  }, async () => {
    const result = await generate(runtime, doc, {
      prompt: privateValues[1], template: JSON.stringify(template), sources: privateValues[3],
    });
    assert.equal(result.sections[0].content, privateValues[0]);
    assert.equal(result.sections[2].content, privateValues[2]);
    assert.deepEqual(doc, before);
  });
  assert.equal(calls.providerCalls, 2);
  assert.equal(calls.analyzerCalls, 2);
});

test('Revision request and prior document are masked on both passes', async () => {
  const doc = document();
  doc.sections = ['a', 'b', 'c'].map(id => ({ id, title: id, content: privateValues[0] }));
  const calls = await withGateway(data => {
    assert.doesNotMatch(data.requestedChange, /Иванов/);
    return completion({ sections: data.expectedSections, issues: [] });
  }, async () => {
    const result = await generate(runtime, doc, EMPTY_MATERIALS, 'Добавить ' + privateValues[0]);
    assert.equal(result.sections[0].content, privateValues[0]);
  });
  assert.equal(calls.providerCalls, 2);
});

test('Review protects sections and restores PII in issue details', async () => {
  const doc = document();
  doc.sections = [{ id: 'a', title: 'Стороны', content: privateValues[0] }];
  await withGateway(data => completion({ issues: [{
    id: 'issue', severity: 'info', title: 'Проверить', detail: data.sections[0].content,
  }] }), async () => {
    const issues = await reviewAI(runtime, doc, EMPTY_MATERIALS);
    assert.equal(issues[0].detail, privateValues[0]);
  });
});

test('Unavailable analyzer means zero model calls and unchanged document', async () => {
  const doc = document(), before = structuredClone(doc);
  const calls = await withGateway(() => { throw new Error('must not reach model'); }, async () => {
    await assert.rejects(() => generate(runtime, doc, EMPTY_MATERIALS),
      error => error instanceof PrivacyError && error.code === 'PII_HTTP_ERROR' && error.upstreamStatus === 503);
    assert.deepEqual(doc, before);
  }, true);
  assert.equal(calls.providerCalls, 0);
});

test('A forged token from the model prevents a generated document from being accepted', async () => {
  const doc = document(), before = structuredClone(doc);
  const calls = await withGateway(data => completion({
    sections: data.expectedSections.map((s: Section) => ({
      ...s, content: '[[CRITERION_PII_foreign_PERSON_1]]',
    })), issues: [],
  }), async () => {
    await assert.rejects(() => generate(runtime, doc, EMPTY_MATERIALS), error =>
      error instanceof PrivacyError && error.code === 'AI_PII_RESTORE_FAILED' &&
      error.cause instanceof PrivacyError && error.cause.code === 'PII_RESTORE_FAILED');
    assert.deepEqual(doc, before);
  });
  assert.equal(calls.providerCalls, 1);
});

test('Failure on the second detection pass prevents the second model call', async () => {
  const original = globalThis.fetch;
  let analyses = 0, calls = 0;
  const doc = makeContract('services', 'ai'), before = structuredClone(doc);
  globalThis.fetch = async (url, options) => {
    if (String(url) === runtime.PII_ANALYZER_URL) {
      if (++analyses === 2) throw new Error('detector failed with sensitive body');
      return Response.json({ profile: 'ru-contract-v1', offsetUnit: 'utf16', spans: [] });
    }
    calls++;
    const data = JSON.parse(JSON.parse(options?.body as string).messages[1].content);
    return completion({ sections: data.expectedSections, issues: [] });
  };
  try {
    await assert.rejects(() => generate(runtime, doc, EMPTY_MATERIALS), PrivacyError);
    assert.equal(calls, 1);
    assert.deepEqual(doc, before);
  } finally { globalThis.fetch = original; }
});
