// Real Natasha/Presidio HTTP service (local Python or --docker); model always simulated.
// Never reads .dev.vars or uses the real OpenAI key.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { generate } from '../lib/criterion/ai.ts';
import { makeContract, EMPTY_MATERIALS } from '../lib/criterion/domain.ts';
import { checkOfficeCase } from './privacy-office-case.mjs';

const dockerMode = process.argv.slice(2).includes('--docker');
if (process.argv.slice(2).some(arg => arg !== '--docker')) throw new Error('Only --docker is supported.');
const python = process.env.PII_TEST_PYTHON;
if (!dockerMode && !python) throw new Error('Set PII_TEST_PYTHON or use --docker with criterion-pii:staging.');
const root = fileURLToPath(new URL('../', import.meta.url));
const token = randomBytes(32).toString('hex');
const childEnv = { ...process.env, PII_ANALYZER_TOKEN: token };
const originalFetch = globalThis.fetch;
let child, container, endpoint, serverError = '', spawnError;
let modelCalls = 0, detectorCalls = 0;
const detectorElapsedMs = [];
const detectorOutcomes = [];

function docker(args, check = true) {
  const result = spawnSync('docker', args, {
    cwd: root, env: childEnv, windowsHide: true, encoding: 'utf8', timeout: 60_000,
  });
  // Do not echo command arguments, environment or runtime response bodies.
  if (check && (result.error || result.status !== 0)) throw new Error('Docker test command failed: ' + args[0]);
  return result;
}

try {
  if (dockerMode) {
    container = docker(['run', '--detach', '--rm', '--read-only',
      '--publish', '127.0.0.1::8100', '--tmpfs', '/tmp:size=64m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--memory', '1g', '--cpus', '0.25', '--pids-limit', '128',
      '--env', 'PII_ANALYZER_TOKEN', 'criterion-pii:staging']).stdout.trim();
    const published = docker(['port', container, '8100/tcp']).stdout.trim();
    assert.match(published, /^127\.0\.0\.1:\d+$/);
    endpoint = 'http://' + published + '/analyze';
  } else {
    const portProbe = createServer();
    portProbe.listen(0, '127.0.0.1');
    await once(portProbe, 'listening');
    const port = portProbe.address().port;
    await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
    endpoint = 'http://127.0.0.1:' + port + '/analyze';
    child = spawn(python, ['-m', 'uvicorn', 'services.pii.app:create_app',
      '--factory', '--host', '127.0.0.1', '--port', String(port), '--no-access-log'],
    { cwd: root, env: childEnv, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', chunk => { serverError = (serverError + chunk.toString()).slice(-4000); });
    child.on('error', error => { spawnError = error; });
  }
  let ready = false;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (spawnError || (child && child.exitCode !== null)) throw new Error('Local detector did not start: ' + serverError);
    try {
      const response = await originalFetch(endpoint.replace(/\/analyze$/, '/health'), {
        headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(1000),
      });
      await response.body?.cancel();
      if (response.ok) { ready = true; break; }
    } catch { /* wait only for the local test process */ }
    await delay(250);
  }
  assert.ok(ready, 'Local detector readiness timed out.');
  const smoke = dockerMode
    ? docker(['exec', container, 'python', 'scripts/check-pii-endpoint.py', '--url', 'http://127.0.0.1:8100/analyze'])
    : spawnSync(python, ['scripts/check-pii-endpoint.py', '--url', endpoint], {
      cwd: root, env: childEnv, windowsHide: true, encoding: 'utf8', timeout: 20_000,
    });
  assert.equal(smoke.status, 0, 'Deployment smoke check failed');
  assert.equal(JSON.parse(smoke.stdout).ok, true);
  const sample = await readFile(new URL('./fixtures/pii-services-contract.txt', import.meta.url), 'utf8');
  const sensitive = ['15.04.2016', '4510', '123456', '4012', '654321', '12.03.1990', '25.08.1988', 'ivanov@example.test', 'petrov@example.test', 'sidorova@example.test', '40817810000012345678', 'Иванов Иван Иванов', 'Петров Пётр Петрович', 'Сидорова Анна Сергеевна', 'Тестовая', 'Примерная', 'Учебная', '+7 (900) 444-55-66', '+7 (900) 777-88-99', '987654321098', '123-456-789 00','Иван Иванов', 'Пётр Петров', 'test-person@example.test', '4510 123456', '+7 (900) 111-22-33'];
  globalThis.fetch = async (url, options) => {
    if (String(url) === endpoint) {
      detectorCalls++;
      const started = performance.now();
      try {
        const response = await originalFetch(url, options);
        detectorOutcomes.push(response.status);
        return response;
      } catch (error) {
        detectorOutcomes.push(error.name);
        throw error;
      } finally { detectorElapsedMs.push(Math.round(performance.now() - started)); }
    }
    assert.equal(String(url), 'https://api.openai.com/v1/chat/completions');
    modelCalls++;
    const raw = options.body;
    for (const value of sensitive) assert.ok(!raw.includes(value), 'Sensitive synthetic fixture reached simulated provider: ' + value);
    assert.ok(!raw.includes(token));
    const data = JSON.parse(JSON.parse(raw).messages[1].content);
    assert.equal(data.facts.price, '45 000 рублей');
    for (const term of ['12 компьютеров', '2 принтера', '01.12.2026', '28.02.2027', '45 000 рублей', '50%', '09:00', '18:00']) assert.ok(data.context.includes(term), 'Contract term was masked: ' + term);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      sections: data.expectedSections.map((section, i) => ({
        ...section, content: i === 0 ? data.facts.partyA : section.content,
      })), issues: [],
    }) } }] });
  };
  const doc = makeContract('services', 'ai');
  doc.facts = { partyA: 'Иван Иванов', detailsA: '4510 123456', price: '45 000 рублей' };
  doc.context = 'Ответственный Пётр Петров. Телефон +7 (900) 111-22-33. Пишите на test-person@example.test.';
  doc.context += '\n' + sample;
  const before = structuredClone(doc);
  const result = await generate({
    OPENAI_API_KEY: 'fixture-not-an-api-key', OPENAI_MODEL: 'fixture-model',
    PII_ANALYZER_URL: endpoint, PII_ANALYZER_TOKEN: token,
  }, doc, { ...EMPTY_MATERIALS, prompt: 'Контакт: test-person@example.test', sources: '' });
  assert.equal(result.sections[0].content, 'Иван Иванов');
  assert.deepEqual(doc, before);
  assert.equal(modelCalls, 2);
  assert.equal(detectorCalls, 2);
  const officeCase = await checkOfficeCase({
    OPENAI_API_KEY: 'fixture-not-an-api-key', OPENAI_MODEL: 'fixture-model',
    PII_ANALYZER_URL: endpoint, PII_ANALYZER_TOKEN: token,
  }, originalFetch);
  // A real HTTP authorization failure must stop the model call as well.
  await assert.rejects(generate({
    OPENAI_API_KEY: 'fixture-not-an-api-key', OPENAI_MODEL: 'fixture-model',
    PII_ANALYZER_URL: endpoint, PII_ANALYZER_TOKEN: 'wrong-fixture-token-'.repeat(4),
  }, doc, { ...EMPTY_MATERIALS, prompt: '', sources: '' }));
  assert.equal(modelCalls, 2);
  assert.equal(detectorCalls, 3);
  assert.deepEqual(doc, before);
  console.log(JSON.stringify({ realDetector: true, docker: dockerMode, simulatedModel: true,
    detectorCalls, modelCalls, detectorElapsedMs, authorizationFailureBlocksModel: true,
    sourceUnchanged: true, restored: true, officeCase }));
} catch (error) {
  console.error(JSON.stringify({ docker: dockerMode, detectorCalls, modelCalls, detectorElapsedMs, detectorOutcomes }));
  throw error;
} finally {
  globalThis.fetch = originalFetch;
  if (container) docker(['rm', '--force', container]);
  if (child && child.exitCode === null && child.pid) {
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
