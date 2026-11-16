// Offline corpus check using real Python detection and the application's TS masking.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { protectRequest } from '../lib/criterion/privacy.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.PII_TEST_PYTHON;
if (!python) throw new Error('Set PII_TEST_PYTHON to Python with services/pii dependencies.');
const args = process.argv.slice(2);
const reportOnly = args.includes('--report-only');
const outputIndex = args.indexOf('--output');
if (args.some((arg, i) => !['--report-only', '--output'].includes(arg) && !(outputIndex >= 0 && i === outputIndex + 1))) throw new Error('Unknown argument');
if (outputIndex >= 0 && !args[outputIndex + 1]) throw new Error('--output requires a file path');
const temp = await mkdtemp(join(tmpdir(), 'criterion-pii-benchmark-'));
try {
  const reportPath = join(temp, 'detection.json');
  const evaluation = spawnSync(python, ['-m', 'services.pii.benchmark', '--output', reportPath], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 4_000_000,
  });
  if (evaluation.error || evaluation.status !== 0) throw new Error('Python benchmark failed: ' + (evaluation.error?.message || evaluation.stderr));
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const corpus = (await readFile(new URL('../tests/fixtures/pii-corpus.jsonl', import.meta.url), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(corpus.length, report.results.length);
  let roundTrips = 0;
  for (const [i, row] of corpus.entries()) {
    const detection = report.results[i];
    assert.equal(detection.id, row.id);
    // Reuse the fresh real detector spans for every occurrence of the source text.
    const detect = async texts => ({ profile: 'ru-contract-v1', offsetUnit: 'utf16',
      spans: texts.flatMap((text, textIndex) => {
        if (['instruction', 'data', 'context', 'messages', 'role', 'text', 'user'].includes(text)) return [];
        assert.equal(text, row.text, 'Unexpected free-text input bypassed corpus detection');
        return detection.detection.spans.map(span => ({ ...span, textIndex }));
      }) });
    const input = { instruction: row.text, data: { context: row.text, messages: [{ role: 'user', text: row.text }] } };
    const before = structuredClone(input);
    const protectedRequest = await protectRequest(input, detect);
    assert.deepEqual(protectedRequest.restore(protectedRequest.payload), before, row.id);
    assert.deepEqual(input, before, row.id);
    // Align every token back to source UTF-16 offsets; substring checks would
    // confuse a sensitive number with the same digits in an ordinary price.
    const aligned = protectedRequest.payload.data.context.replace(/\[\[CRITERION_PII_[A-Za-z0-9_]+\]\]/g,
      token => '\0'.repeat(protectedRequest.restore(token).length));
    assert.equal(aligned.length, row.text.length);
    if (!detection.missed.length) for (const entity of row.sensitive) {
      assert.equal(aligned.slice(entity.start, entity.end), '\0'.repeat(entity.end - entity.start), row.id);
    }
    roundTrips++;
  }
  report.typescriptRoundTrips = roundTrips;
  report.allChecksPassed = report.metrics.passedCases === corpus.length;
  if (outputIndex >= 0) {
    const destination = resolve(root, args[outputIndex + 1]);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ allChecksPassed: report.allChecksPassed, syntheticOnly: true,
    independentHoldout: false, metrics: report.metrics, typescriptRoundTrips: roundTrips }, null, 2));
  if (!report.allChecksPassed && !reportOnly) process.exitCode = 1;
} finally { await rm(temp, { recursive: true, force: true }); }
