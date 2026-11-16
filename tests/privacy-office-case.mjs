// Independently annotated, synthetic office-services example from the conversation.
// Called by privacy-e2e.mjs against its real HTTP detector; never uses an API key.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { protectRequest } from '../lib/criterion/privacy.ts';
import { trustedDetector } from '../lib/criterion/privacy-detector.ts';
import { interview, generate, reviewAI } from '../lib/criterion/ai.ts';
import { makeContract, EMPTY_MATERIALS } from '../lib/criterion/domain.ts';

export async function checkOfficeCase(runtime, realFetch) {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/pii-office-services-case.json', import.meta.url), 'utf8'));
  assert.equal(fixture.syntheticOnly, true);
  for (const label of [...fixture.sensitive, ...fixture.keep]) {
    assert.equal(fixture.text.slice(label.start, label.end), label.text, 'Invalid fixture offsets');
  }
  const parentFetch = globalThis.fetch;
  const markers = /\[\[CRITERION_PII_[A-Za-z0-9_]+\]\]/g;
  let detectorCalls = 0, modelCalls = 0, maskedInterview;
  const detectorElapsedMs = [];
  try {
    globalThis.fetch = async (url, options) => {
      if (String(url) === runtime.PII_ANALYZER_URL) {
        detectorCalls++;
        const started = performance.now();
        try { return await realFetch(url, options); }
        finally { detectorElapsedMs.push(Math.round(performance.now() - started)); }
      }
      assert.equal(String(url), 'https://api.openai.com/v1/chat/completions');
      modelCalls++;
      // A random token scope can coincidentally contain a short passport number.
      const unprotectedText = options.body.replace(markers, '');
      for (const { text } of fixture.sensitive) assert.ok(!unprotectedText.includes(text), 'PII in model request: ' + text);
      assert.ok(!options.body.includes(runtime.PII_ANALYZER_TOKEN));
      const request = JSON.parse(options.body), input = JSON.parse(request.messages[1].content);
      for (const { text } of fixture.keep) assert.ok(input.context.includes(text), 'A contract condition was masked');
      let answer;
      if (request.messages[0].content.includes('Режим интервью')) {
        maskedInterview = input.context;
        answer = { reply: input.context, facts: { partyA: input.facts.partyA, partyB: input.facts.partyB }, ready: true };
      } else if (input.expectedSections) {
        answer = { sections: input.expectedSections.map((s, i) => ({ ...s, content: i === 0 ? input.context : s.content })), issues: [] };
      } else {
        answer = { issues: [{ id: 'synthetic-echo', severity: 'info', title: 'Контрольное повторение', detail: input.context }] };
      }
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] });
    };
    // Coverage is checked against source offsets, not against detector predictions.
    const source = { instruction: 'Проверить вымышленный пример.', data: { context: fixture.text } };
    const protectedRequest = await protectRequest(source, trustedDetector(runtime));
    const aligned = protectedRequest.payload.data.context.replace(markers, token => '\0'.repeat(protectedRequest.restore(token).length));
    assert.equal(aligned.length, fixture.text.length);
    for (const { start, end, text } of fixture.sensitive) {
      assert.equal(aligned.slice(start, end), '\0'.repeat(end - start), 'Not fully masked: ' + text);
    }
    for (const { start, end, text } of fixture.keep) assert.equal(aligned.slice(start, end), text, 'Damaged contract condition');
    assert.deepEqual(protectedRequest.restore(protectedRequest.payload), source);

    const doc = makeContract('services', 'ai');
    doc.context = fixture.text;
    doc.facts = { partyA: 'Смирнов Алексей Викторович', partyB: 'Кузнецова Мария Андреевна', price: '48 000 рублей' };
    doc.messages.push({ id: 'synthetic-user', role: 'user', text: fixture.text, at: '2026-11-16T12:00:00.000Z' });
    const before = structuredClone(doc);
    const reply = await interview(runtime, doc, EMPTY_MATERIALS);
    assert.equal(reply.reply, fixture.text);
    assert.equal(reply.facts.partyA, doc.facts.partyA);
    assert.equal(reply.facts.partyB, doc.facts.partyB);
    const generated = await generate(runtime, doc, EMPTY_MATERIALS);
    assert.equal(generated.sections[0].content, fixture.text);
    const revised = await generate(runtime, { ...doc, sections: generated.sections }, EMPTY_MATERIALS,
      'Контакт для согласования: Орлова Елена Сергеевна, orlova@example.test. Остальные условия сохранить.');
    assert.equal(revised.sections[0].content, fixture.text);
    const issues = await reviewAI(runtime, { ...doc, sections: revised.sections }, EMPTY_MATERIALS);
    assert.equal(issues[0].detail, fixture.text);
    assert.deepEqual(doc, before);
    assert.equal(modelCalls, 6); // interview, two generation passes, two revision passes, review
    assert.equal(detectorCalls, 7); // coverage plus each of the six model requests
    const result = { passed: true, syntheticOnly: true, sensitiveSpans: fixture.sensitive.length,
      keepSpans: fixture.keep.length, missedSpans: 0, damagedKeepSpans: 0, exactRestoration: true,
      sourceUnchanged: true, modelCalls, simulatedModel: true, detectorCalls, detectorElapsedMs };
    const report = '# Проверка примера: обслуживание офиса\n\n' +
      'Проверены исходный текст из чата, настоящий HTTP-детектор, интервью, два прохода генерации, два прохода правки и ревью. Ответы модели имитируются.\n\n' +
      `ПДн скрыты: **${result.sensitiveSpans}/${result.sensitiveSpans}**. Блоки условий сохранены: **${result.keepSpans}/${result.keepSpans}**. ` +
      'Восстановление побуквенно точное. Исходный документ не изменён.\n\n' +
      'Одна из строк фактического запроса интервью показана ниже. Заголовки, API-ключи и служебный токен в отчёт не включаются. Все сведения вымышлены.\n\n' +
      '## Исходный текст\n\n```text\n' + fixture.text + '\n```\n\n' +
      '## Перед моделью (перехваченный запрос интервью)\n\n```text\n' + maskedInterview + '\n```\n\n' +
      '## После восстановления ответа\n\n```text\n' + reply.reply + '\n```\n\n' +
      '## Результаты автоматических проверок\n\n```json\n' + JSON.stringify(result, null, 2) + '\n```\n\n' +
      'Это проверка конкретного примера. Общие известные ложные срабатывания на корпусе описаны в docs/privacy/README.md.\n';
    const outputs = new URL('../outputs/', import.meta.url);
    await mkdir(outputs, { recursive: true });
    const reportUrl = new URL('pii-office-services-check.md', outputs);
    await writeFile(reportUrl, report, 'utf8');
    return { ...result, report: fileURLToPath(reportUrl) };
  } finally { globalThis.fetch = parentFetch; }
}
