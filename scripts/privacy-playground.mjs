// Local interactive diagnostic tool. Use invented data: full payloads are printed.
// Never reads .dev.vars or uses the real OpenAI key.
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { interview, generate, reviewAI } from '../lib/criterion/ai.ts';
import { makeContract, EMPTY_MATERIALS } from '../lib/criterion/domain.ts';

const python = process.env.PII_TEST_PYTHON;
if (!python) throw new Error('Set PII_TEST_PYTHON to the detector virtualenv Python executable.');
const root = fileURLToPath(new URL('../', import.meta.url));
const portProbe = createServer();
portProbe.listen(0, '127.0.0.1');
await once(portProbe, 'listening');
const port = portProbe.address().port;
await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
const token = randomBytes(32).toString('hex');
const endpoint = 'http://127.0.0.1:' + port + '/analyze';
const child = spawn(python, ['-m', 'uvicorn', 'services.pii.app:create_app',
  '--factory', '--host', '127.0.0.1', '--port', String(port), '--no-access-log'],
{ cwd: root, env: { ...process.env, PII_ANALYZER_TOKEN: token }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let serverError = '', spawnError;
child.stderr.on('data', chunk => { serverError = (serverError + chunk.toString()).slice(-4000); });
child.on('error', error => { spawnError = error; });
const originalFetch = globalThis.fetch;
let modelCalls = 0, detectorCalls = 0;
let lines;
const print = (label, value) => console.log('\n' + label + '\n' + JSON.stringify(value, null, 2));

try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (spawnError || child.exitCode !== null) throw new Error('Local detector did not start: ' + serverError);
    try {
      const response = await originalFetch(endpoint, {
        method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: ['Проверка'] }), signal: AbortSignal.timeout(1000),
      });
      if (response.ok) { ready = true; break; }
    } catch { /* wait only for the local test process */ }
    await delay(250);
  }
  assert.ok(ready, 'Local detector readiness timed out.');
  lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  console.log('Локальная проверка ПДн. Используйте только вымышленные данные: весь текст виден в консоли.');
  console.log('Распознаватель настоящий; модель имитируется. Ключ OpenAI и .dev.vars не читаются.');
  console.log('Введите сообщение одной строкой. Команды: /generate — черновик, /review — проверка, /reset — новая история, /exit — выход.');
  console.log('Ответ модели специально повторяет замаскированный ввод, чтобы проверить восстановление. Это не проверка качества генерации.');
  globalThis.fetch = async (url, options) => {
    if (String(url) === endpoint) {
      detectorCalls++;
      const response = await originalFetch(url, options);
      print('[ДЕТЕКТОР: интервалы UTF-16 в строках запроса]', await response.clone().json());
      return response;
    }
    assert.equal(String(url), 'https://api.openai.com/v1/chat/completions');
    modelCalls++;
    const request = JSON.parse(options.body);
    print('[ЗАПРОС К МОДЕЛИ #' + modelCalls + ': только тело, без заголовков и ключа]', request);
    const data = JSON.parse(request.messages[1].content);
    const lastText = data.messages?.filter(m => m.role === 'user').at(-1)?.text || data.context || 'Тестовый текст';
    const result = request.messages[0].content.includes('Режим интервью')
      ? { reply: 'Тестовое повторение: ' + lastText, facts: {}, ready: false }
      : data.expectedSections
        ? { sections: data.expectedSections.map(s => ({ ...s, content: s.content + '\nТестовое повторение: ' + lastText })), issues: [] }
        : { issues: [{ id: 'test', severity: 'info', title: 'Тестовое повторение', detail: data.sections?.[0]?.content || lastText }] };
    print('[ИМИТАЦИЯ ОТВЕТА МОДЕЛИ: до восстановления]', result);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] });
  };
  const runtime = { OPENAI_API_KEY: 'fixture-not-an-api-key', OPENAI_MODEL: 'fixture-model',
    PII_ANALYZER_URL: endpoint, PII_ANALYZER_TOKEN: token };
  let doc = makeContract('services', 'ai');
  const materials = { ...EMPTY_MATERIALS };
  for await (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    if (text === '/exit') break;
    if (text === '/reset') { doc = makeContract('services', 'ai'); console.log('История очищена.'); continue; }
    const before = structuredClone(doc), callsBefore = modelCalls;
    try {
      let result;
      if (text === '/generate') {
        result = await generate(runtime, doc, materials);
        doc.sections = result.sections;
      } else if (text === '/review') {
        if (!doc.sections.length) { console.log('Сначала выполните /generate.'); continue; }
        result = await reviewAI(runtime, doc, materials);
      } else {
        doc.messages.push({ id: crypto.randomUUID(), role: 'user', text, at: new Date().toISOString() });
        result = await interview(runtime, doc, materials);
        doc.messages.push({ id: crypto.randomUUID(), role: 'assistant', text: result.reply, at: new Date().toISOString() });
      }
      print('[РЕЗУЛЬТАТ ПОСЛЕ ВОССТАНОВЛЕНИЯ]', result);
    } catch {
      doc = before;
      console.log('[ОШИБКА] Операция остановлена, история не изменена. Вызовов имитации модели: ' + (modelCalls - callsBefore));
    }
    console.log('Введите следующий текст или /exit.');
  }
  print('[ИТОГО]', { realDetector: true, simulatedModel: true, detectorCalls, modelCalls });
} finally {
  lines?.close();
  globalThis.fetch = originalFetch;
  if (child.exitCode === null && child.pid) {
    if (process.platform === 'win32') {
      // Stop only this test's process tree, including the venv launcher child.
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([once(child, 'exit'), delay(3000)]);
    }
  }
}
