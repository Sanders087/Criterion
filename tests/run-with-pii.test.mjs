import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { configuration } from '../scripts/run-with-pii.mjs';

const token = 'synthetic-process-test-token-123456789';
const moduleUrl = new URL('../scripts/run-with-pii.mjs', import.meta.url).href;
const fixture = fileURLToPath(new URL('./fixtures/shared-process.mjs', import.meta.url));

test('shared-container config isolates Python secrets and pins the loopback endpoint', () => {
  const config = configuration({ PII_ANALYZER_TOKEN: token, OPENAI_API_KEY: 'synthetic-key',
    DATABASE_URL: 'synthetic-db', RESEND_API_KEY: 'synthetic-mail', TBANK_PASSWORD_BASE64: 'IWZpeHR1cmU=', PATH: process.env.PATH });
  assert.equal(config.siteEnv.OPENAI_API_KEY, 'synthetic-key');
  assert.equal(config.siteEnv.PII_ANALYZER_URL, 'http://127.0.0.1:8100/analyze');
  assert.equal(config.siteEnv.HOSTNAME, '0.0.0.0');
  assert.equal(config.siteEnv.TBANK_PASSWORD_BASE64, 'IWZpeHR1cmU=');
  for (const key of ['OPENAI_API_KEY', 'DATABASE_URL', 'RESEND_API_KEY', 'TBANK_PASSWORD_BASE64']) assert.equal(config.piiEnv[key], undefined);
  for (const extra of [{PII_ANALYZER_TOKEN:'short'}, {PII_ANALYZER_TOKEN:'x'.repeat(32)+'\n'},
    {PORT:'8100'}, {PORT:'bad'}, {PII_ANALYZER_URL:'https://outside.test/analyze'}, {SITE_HEALTH_PATH:'//outside.test'}]) {
    assert.throws(() => configuration({ PII_ANALYZER_TOKEN: token, ...extra }));
  }
});

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function waitFor(url) {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(url, {signal:AbortSignal.timeout(250)});
      if (res.ok) return await res.json();
    } catch { /* test child is starting */ }
    await delay(50);
  }
  throw new Error('Test child did not start');
}
async function running() {
  const port = await freePort();
  const env = { ...process.env, PII_ANALYZER_TOKEN:token, PORT:String(port),
    OPENAI_API_KEY:'synthetic-key', DATABASE_URL:'synthetic-db' };
  delete env.PII_ANALYZER_URL;
  delete env.SITE_HEALTH_PATH;
  const source = `import {supervise} from ${JSON.stringify(moduleUrl)};
    process.exitCode = await supervise(${JSON.stringify([process.execPath, fixture, 'site'])},
      {piiCommand:${JSON.stringify([process.execPath, fixture, 'pii'])}});`;
  const child = spawn(process.execPath, ['--input-type=module','-e',source], {env, windowsHide:true, stdio:['ignore','pipe','pipe']});
  const exited = once(child,'exit');
  let logs = '';
  child.stdout.on('data', chunk => {logs += chunk});
  child.stderr.on('data', chunk => {logs += chunk});
  return {port, env, child, exited, logs:() => logs};
}
async function shutdown(r) {
  // Stop the direct fixture children even on Windows (no process groups there).
  for (const port of [r.port,8100]) {
    try { await fetch('http://127.0.0.1:'+port+'/stop', {signal:AbortSignal.timeout(250)}); } catch {}
  }
  if (r.child.exitCode === null) r.child.kill();
  await r.exited;
}

test('real child processes start in order; detector loss stops site; combined health fails', {timeout:20000}, async () => {
  const r = await running();
  try {
    const state = await waitFor('http://127.0.0.1:'+r.port+'/');
    assert.equal(state.detectorReadyAtSiteStart, true);
    assert.equal(state.hasModelKey, true);
    const health = () => new Promise(resolve => {
      const p = spawn(process.execPath, [fileURLToPath(new URL('../scripts/run-with-pii.mjs', import.meta.url)), '--healthcheck'],
        {env:r.env, windowsHide:true, stdio:'ignore'});
      p.once('exit', resolve);
    });
    assert.equal(await health(), 0);
    await fetch('http://127.0.0.1:8100/stop');
    const [code] = await r.exited;
    assert.equal(code, 1);
    assert.equal(await health(), 1);
    await assert.rejects(fetch('http://127.0.0.1:'+r.port+'/', {signal:AbortSignal.timeout(500)}));
    assert.ok(!r.logs().includes(token));
    assert.ok(!r.logs().includes('synthetic-key'));
    assert.match(r.logs(), /service\.ready/);
    assert.match(r.logs(), /service\.exited/);
    assert.match(r.logs(), /services\.stopping/);
  } finally { await shutdown(r); }
});

test('site exit stops detector, even when site exits successfully', {timeout:20000}, async () => {
  const r = await running();
  try {
    await waitFor('http://127.0.0.1:'+r.port+'/');
    await fetch('http://127.0.0.1:'+r.port+'/stop');
    assert.equal((await r.exited)[0], 1);
    await assert.rejects(fetch('http://127.0.0.1:8100/health', {signal:AbortSignal.timeout(500)}));
  } finally { await shutdown(r); }
});

test('SIGTERM stops both process groups on Linux', {skip:process.platform==='win32', timeout:20000}, async () => {
  const r = await running();
  try {
    await waitFor('http://127.0.0.1:'+r.port+'/');
    r.child.kill('SIGTERM');
    assert.equal((await r.exited)[0], 0);
    for(const port of [r.port,8100]) await assert.rejects(fetch('http://127.0.0.1:'+port+'/', {signal:AbortSignal.timeout(500)}));
  } finally {await shutdown(r);}
});
