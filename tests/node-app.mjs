import { fork } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { openDatabase } from '../db/sqlite.mjs';

// Only the explicit mock surface needed by these tests. Unmatched calls always fail.
export function createFetchMock() {
  const rules = [];
  return {
    disableNetConnect() {},
    get(origin) { return { intercept(match) { return { reply(status, body) {
      const rule = { origin, ...match, status, body, persistent: false }; rules.push(rule);
      return { persist() { rule.persistent = true; } };
    } }; } }; },
    async dispatch(message) {
      const url = new URL(message.url);
      const index = rules.findIndex(rule => rule.origin === url.origin && rule.path === url.pathname + url.search &&
        rule.method === message.method && Object.entries(rule.headers || {}).every(([key, value]) => message.headers[key.toLowerCase()] === value));
      if (index < 0) throw new Error('Unmocked outbound request: ' + url.origin + url.pathname);
      const rule = rules[index];
      if (!rule.persistent) rules.splice(index, 1);
      return { status: rule.status, body: typeof rule.body === 'function' ? await rule.body(message) : rule.body,
        headers: { 'content-type': 'application/json' } };
    },
  };
}

export async function createTestApp({ bindings = {}, fetchMock = createFetchMock(), localOrigin = false } = {}) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'criterion-node-test-'));
  const database = openDatabase(join(directory, 'test.sqlite'), { migrationsDir: join(root, 'drizzle') });
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  // Do not inherit .dev.vars, API keys, mail/bank settings, or NODE_OPTIONS.
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', HOSTNAME: '127.0.0.1', PORT: String(port),
    DATABASE_PATH: join(directory, 'test.sqlite'), AUTH_PUBLIC_URL: 'https://criterion.test',
    TRUSTED_CLIENT_IP_HEADER: 'cf-connecting-ip', ...bindings });
  if (localOrigin) env.AUTH_PUBLIC_URL = 'http://127.0.0.1:' + port;
  const child = fork(join(root, 'scripts/start-site.mjs'), [], { cwd: root, env,
    execArgv: ['--import', new URL('./provider-preload.mjs', import.meta.url).href], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '', exited = false;
  child.stdout.on('data', data => { output = (output + data).slice(-8000); });
  child.stderr.on('data', data => { output = (output + data).slice(-8000); });
  const exit = once(child, 'exit').then(() => { exited = true; });
  child.on('message', async message => {
    if (message?.type !== 'fetch') return;
    let result;
    try { result = await fetchMock.dispatch(message); }
    catch (error) { result = { error: error.message }; }
    if (child.connected) child.send({ type: 'fetch-result', id: message.id, ...result });
  });
  async function dispose() {
    if (!exited) { child.kill(); await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 3000).unref())]); }
    if (!exited) { child.kill('SIGKILL'); await exit; }
    database.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  const origin = 'http://127.0.0.1:' + port;
  try {
    let ready = false;
    const startupDeadline = Date.now() + 60_000;
    while (Date.now() < startupDeadline) {
      if (exited) throw new Error('Next server exited: ' + output);
      try { ready = (await fetch(origin + '/api/health', { signal: AbortSignal.timeout(500) })).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('Next server did not become ready: ' + output);
    return { database: () => database, origin, dispatchFetch(url, init) {
      const target = new URL(url); target.protocol = 'http:'; target.host = '127.0.0.1:' + port;
      return fetch(target, { ...init, signal: AbortSignal.timeout(20000) });
    }, dispose, logs: () => output };
  } catch (error) { await dispose(); throw error; }
}
