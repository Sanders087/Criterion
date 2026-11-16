// Local-only preview of the built Site + real Docker detector. Never deploys.
import { createRequire } from 'node:module';
import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { localMigrationChecksums } from './local-migration-checksums.mjs';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--mock-model')) throw new Error('Supported option: --mock-model');
const mockModel = args.includes('--mock-model');
const root = fileURLToPath(new URL('../', import.meta.url));
const serverRoot = join(root, 'dist/server');
await access(join(serverRoot, 'index.js')).catch(() => { throw new Error('Build the site first: pnpm build'); });
let apiKey = 'local-simulated-key', model = 'gpt-4.1';
if (!mockModel) {
  let local = {};
  try { local = parseEnv(await readFile(join(root, '.dev.vars'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  apiKey = process.env.OPENAI_API_KEY || local.OPENAI_API_KEY;
  model = process.env.OPENAI_MODEL || local.OPENAI_MODEL || model;
  if (!apiKey) throw new Error('Set the test OPENAI_API_KEY in .dev.vars or use --mock-model.');
}
const require = createRequire(import.meta.url);
const wr = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare } = wr('miniflare');
const token = randomBytes(32).toString('hex');
const containerEnv = { ...process.env, PII_ANALYZER_TOKEN: token };
let container, mf, closing = false;
function docker(args, check = true) {
  const result = spawnSync('docker', args, { cwd: root, env: containerEnv, windowsHide: true,
    encoding: 'utf8', timeout: 60_000 });
  if (check && (result.error || result.status !== 0)) throw new Error('Docker ' + args[0] + ' failed. Check Docker Desktop and criterion-pii:staging.');
  return result.stdout?.trim();
}
async function cleanup() {
  if (closing) return;
  closing = true;
  try { await mf?.dispose(); }
  finally { if (container) docker(['rm', '--force', container], false); }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().finally(() => process.exit(0)); });

function simulatedResponse(body) {
  const input = JSON.parse(body.messages[1].content);
  const warning = '[ЛОКАЛЬНАЯ ИМИТАЦИЯ ИИ — тест интерфейса, не готовый договор]';
  let result;
  if (body.messages[0].content.includes('Режим интервью')) {
    result = { reply: warning + ' Данные приняты. Можно перейти к тестовому черновику.', facts: {}, ready: true };
  } else if (input.expectedSections) {
    const facts = Object.entries(input.facts || {}).map(([key, value]) => key + ': ' + value).join('\n');
    result = { sections: input.expectedSections.map((s, i) => ({ ...s,
      content: warning + '\n' + s.content + (i === 0 ? '\n' + facts : ''),
    })), issues: [{ id: 'local-mock', severity: 'high', title: 'Модель имитируется', detail: warning }] };
  } else {
    result = { issues: [{ id: 'local-mock', severity: 'high', title: 'Модель имитируется', detail: warning }] };
  }
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] });
}

try {
  docker(['info', '--format', '{{.ServerVersion}}']);
  container = docker(['run', '--detach', '--rm', '--read-only', '--publish', '127.0.0.1::8100',
    '--tmpfs', '/tmp:size=64m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--memory', '1g', '--cpus', '0.25', '--pids-limit', '128', '--label', 'criterion.local-pii-preview=true', '--env', 'PII_ANALYZER_TOKEN', 'criterion-pii:staging']);
  const port = docker(['port', container, '8100/tcp']);
  if (!/^127\.0\.0\.1:\d+$/.test(port)) throw new Error('Unexpected Docker port binding');
  const endpoint = 'http://' + port + '/analyze';
  const readyDeadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < readyDeadline) {
    try {
      const response = await fetch('http://' + port + '/health', {
        headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(1000),
      });
      await response.body?.cancel();
      if (response.ok) { ready = true; break; }
    } catch { /* The local container may still be starting. */ }
    await delay(250);
  }
  if (!ready) throw new Error('Local Docker detector did not become ready.');
  const files = (await readdir(serverRoot, { recursive: true })).filter(f => /\.m?js$/.test(f));
  const state = join(root, '.wrangler/pii-local');
  await mkdir(state, { recursive: true });
  mf = new Miniflare({
    host: '127.0.0.1', port: 8787, cf: false,
    modules: ['index.js', ...files.filter(f => f !== 'index.js')].map(path => ({ type: 'ESModule', path: join(serverRoot, path) })),
    modulesRoot: serverRoot, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'],
    assets: { directory: join(root, 'dist/client'), routerConfig: { has_user_worker: true } },
    d1Databases: { DB: 'criterion-pii-local' }, d1Persist: join(state, 'd1'),
    bindings: { PII_ANALYZER_URL: endpoint, PII_ANALYZER_TOKEN: token, OPENAI_API_KEY: apiKey,
      OPENAI_MODEL: model, AUTH_PUBLIC_URL: 'http://localhost:8787', TBANK_ENABLED: 'false', TBANK_MODE: 'demo' },
    // Read only the test model key; never copy bank/mail/cloud credentials into this Site.
    outboundService: async request => {
      const isPii = request.url === endpoint;
      const isModel = request.url === 'https://api.openai.com/v1/chat/completions';
      if ((!isPii && !isModel) || request.method !== 'POST') return new Response('Local preview blocks this outbound request', { status: 502 });
      const started = performance.now();
      const body = await request.text();
      const markerCount = isModel ? (body.match(/\[\[CRITERION_PII_/g) || []).length : undefined;
      try {
        const response = isModel && mockModel ? simulatedResponse(JSON.parse(body)) : await fetch(request.url, {
          method: 'POST', headers: Object.fromEntries(request.headers), body, redirect: 'manual',
          signal: AbortSignal.timeout(isPii ? 8000 : 80000),
        });
        console.log(JSON.stringify({ service: isPii ? 'pii' : 'model', simulated: isModel && mockModel,
          status: response.status, elapsedMs: Math.round(performance.now() - started), markerCount }));
        return response;
      } catch {
        console.log(JSON.stringify({ service: isPii ? 'pii' : 'model', status: 'unavailable', elapsedMs: Math.round(performance.now() - started) }));
        return new Response('Local upstream unavailable', { status: 503 });
      }
    },
  });
  await mf.ready;
  const db = await mf.getD1Database('DB');
  await db.prepare('CREATE TABLE IF NOT EXISTS _criterion_local_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL)').run();
  for (const file of (await readdir(join(root, 'drizzle'))).filter(f => f.endsWith('.sql')).sort()) {
    const sql = await readFile(join(root, 'drizzle', file), 'utf8');
    const { canonical: checksum, accepted } = localMigrationChecksums(sql);
    const previous = await db.prepare('SELECT checksum FROM _criterion_local_migrations WHERE name=?').bind(file).first();
    if (previous) {
      if (!accepted.has(previous.checksum)) throw new Error('An applied local migration changed: ' + file);
      continue;
    }
    await db.batch([...sql.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean).map(s => db.prepare(s)),
      db.prepare('INSERT INTO _criterion_local_migrations (name,checksum) VALUES (?,?)').bind(file, checksum)]);
  }
  console.log('Local Criterion: http://localhost:8787');
  console.log(mockModel ? 'MODEL IS SIMULATED. Docker detector is real; no model charges.' : 'LIVE test model connected. Requests use the test key and may incur charges. Use synthetic data only.');
  console.log('Local D1 persists in .wrangler/pii-local/. Bank and email are disabled.');
  console.log('Commands: unlock DOCUMENT_ID (one synthetic local document), stop. Ctrl+C also stops this preview and its Docker container.');
  const lines = createInterface({ input: process.stdin });
  lines.on('line', line => {
    void (async () => {
      const command = line.trim();
      if (command === 'stop') { lines.close(); await cleanup(); process.exit(0); }
      const match = /^unlock ([a-zA-Z0-9-]{1,100})$/.exec(command);
      if (!match) { console.log('Commands: unlock DOCUMENT_ID, stop'); return; }
      const result = await db.prepare("UPDATE documents SET billing_state='paid', ai_operations_used=0 WHERE id=? AND billing_state='unpaid' AND lock_token IS NULL AND NOT EXISTS (SELECT 1 FROM payment_orders WHERE document_id=?)").bind(match[1], match[1]).run();
      console.log(JSON.stringify({ localOnly: true, documentsUnlocked: result.meta.changes }));
    })().catch(() => console.error('Local command failed. No credentials or document contents logged.'));
  });
} catch (error) {
  await cleanup();
  console.error('Local preview failed (' + error.name + '). Check the build, port 8787 and Docker Desktop.');
  process.exitCode = 1;
}
