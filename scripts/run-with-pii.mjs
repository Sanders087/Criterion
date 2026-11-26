// One Linux container: trusted loopback detector + the team's Node.js server.
// No shell commands, request-body logging, or fallback around PII protection.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { diagnostic, safeErrorCode } from '../lib/diagnostics.mjs';

const endpoint = 'http://127.0.0.1:8100/analyze';
function configurationError(code, message) {
  return Object.assign(new Error(message), { code });
}
export function configuration(env = process.env) {
  if (!/^[\x21-\x7e]{32,256}$/.test(env.PII_ANALYZER_TOKEN || '')) {
    throw configurationError('PII_TOKEN_CONFIG', 'Set PII_ANALYZER_TOKEN to 32–256 printable ASCII characters without spaces.');
  }
  if (env.PII_ANALYZER_URL && env.PII_ANALYZER_URL !== endpoint) {
    throw configurationError('PII_URL_CONFIG', 'The shared container requires PII_ANALYZER_URL=' + endpoint);
  }
  const port = env.PORT || '3000';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || Number(port) === 8100) {
    throw configurationError('PORT_CONFIG', 'PORT must be a valid site port other than 8100.');
  }
  const healthPath = env.SITE_HEALTH_PATH || '/';
  if (!/^\/(?!\/)[a-zA-Z0-9/_-]*$/.test(healthPath)) throw configurationError('HEALTH_PATH_CONFIG', 'Invalid SITE_HEALTH_PATH.');
  const siteEnv = { ...env, PORT: port, HOSTNAME: '0.0.0.0', HOST: '0.0.0.0', PII_ANALYZER_URL: endpoint };
  // Do not pass model, database, mail, bank, or provider secrets to Python.
  const piiEnv = Object.fromEntries(['PATH', 'SystemRoot', 'LANG', 'LC_ALL', 'TZ', 'TMP', 'TEMP']
    .filter(key => env[key]).map(key => [key, env[key]]));
  Object.assign(piiEnv, {
    PII_ANALYZER_TOKEN: env.PII_ANALYZER_TOKEN,
    PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1',
    OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1',
  });
  return { siteEnv, piiEnv, siteHealth: 'http://127.0.0.1:' + port + healthPath };
}

export async function serviceStatus(config, includeSite = true) {
  async function check(url, pii) {
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000),
        headers: { Connection: 'close', ...(pii ? { Authorization: 'Bearer ' + config.piiEnv.PII_ANALYZER_TOKEN } : {}) } });
      let ready = pii ? response.status === 200 : response.status >= 200 && response.status < 400;
      if (pii && ready) ready = (await response.json()).status === 'ready';
      else await response.body?.cancel();
      return { status: ready ? 'ready' : 'unavailable', httpStatus: response.status };
    } catch { return { status: 'unreachable' }; }
  }
  const [pii, site] = await Promise.all([
    check('http://127.0.0.1:8100/health', true),
    includeSite ? check(config.siteHealth, false) : Promise.resolve(null),
  ]);
  return { pii, ...(includeSite ? { site } : {}) };
}
export async function healthy(config, includeSite = true) {
  const state = await serviceStatus(config, includeSite);
  return state.pii.status === 'ready' && (!includeSite || state.site.status === 'ready');
}

// The optional command override supports isolated process-lifecycle tests.
// Production CLI always uses the real Python ASGI service.
export async function supervise(siteCommand, { env = process.env, piiCommand } = {}) {
  const config = configuration(env);
  if (!Array.isArray(siteCommand) || !siteCommand.length || siteCommand.some(x => typeof x !== 'string' || !x)) {
    throw configurationError('SITE_COMMAND_CONFIG', 'Usage: node scripts/run-with-pii.mjs -- node path/to/server.js');
  }
  const children = [];
  let stopping = false;
  let monitorTimer;
  let lastHealth = '', lastHealthLog = 0;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  function signalChild(child, signal) {
    try {
      if (process.platform === 'win32') child.kill(signal);
      else if (child.pid) process.kill(-child.pid, signal);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  async function stop(code) {
    if (stopping) return;
    stopping = true;
    clearTimeout(monitorTimer);
    diagnostic('services.stopping', { exitCode: code });
    const exits = children.map(child => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve() : new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); }));
    for (const child of children) signalChild(child, 'SIGTERM');
    let timer;
    await Promise.race([Promise.all(exits), new Promise(resolve => {
      timer = setTimeout(() => { for (const child of children) signalChild(child, 'SIGKILL'); resolve(); }, 8000);
    })]);
    clearTimeout(timer);
    // Clean up descendants of a site that exited while leaving subprocesses alive.
    if (process.platform !== 'win32') for (const child of children) signalChild(child, 'SIGKILL');
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('SIGINT', onTerm);
    finish(code);
  }
  const onTerm = () => { diagnostic('services.signal', { reason: 'termination_requested' }); void stop(0); };
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onTerm);
  function launch(command, childEnv, name) {
    const child = spawn(command[0], command.slice(1), {
      env: childEnv, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
      detached: process.platform !== 'win32',
    });
    children.push(child);
    diagnostic('service.starting', { component: name });
    child.once('error', cause => {
      diagnostic('service.failed', { component: name, reason: 'spawn_failed', causeCode: safeErrorCode(cause) }, 'error');
      console.error('Criterion: failed to start ' + name + '.');
      void stop(1);
    });
    child.once('exit', (code, signal) => {
      diagnostic('service.exited', { component: name, exitCode: code, signal, expected: stopping }, stopping ? 'info' : 'error');
      if (!stopping) {
        console.error('Criterion: ' + name + ' stopped; shutting down the container.');
        void stop(1);
      }
    });
    return child;
  }
  async function monitor() {
    if (stopping) return;
    const state = await serviceStatus(config);
    if (stopping) return;
    const key = JSON.stringify(state), now = Date.now();
    if (key !== lastHealth || now - lastHealthLog >= 300_000) {
      diagnostic('services.health', state);
      lastHealth = key; lastHealthLog = now;
    }
    // Poll during startup, then every 30 seconds; log changes and a five-minute heartbeat.
    monitorTimer = setTimeout(monitor, state.site.status === 'ready' ? 30_000 : 2000);
    monitorTimer.unref();
  }
  try {
    launch(piiCommand || [env.PII_PYTHON || 'python', '-m', 'uvicorn', 'services.pii.app:create_app',
      '--factory', '--host', '127.0.0.1', '--port', '8100', '--workers', '1',
      '--no-access-log', '--limit-concurrency', '4'], config.piiEnv, 'PII detector');
    const deadline = Date.now() + 90_000;
    while (!stopping && !(await healthy(config, false))) {
      if (Date.now() >= deadline) {
        diagnostic('service.failed', { component: 'PII detector', reason: 'readiness_timeout' }, 'error');
        console.error('Criterion: PII detector readiness timed out.');
        await stop(1);
        break;
      }
      await delay(250);
    }
    if (!stopping) {
      console.log('Criterion: PII detector ready; starting site.');
      diagnostic('service.ready', { component: 'PII detector' });
      launch(siteCommand, config.siteEnv, 'site');
      void monitor();
    }
    return await done;
  } catch (error) {
    diagnostic('startup.failed', { phase: 'supervisor', errorCode: safeErrorCode(error) }, 'error');
    await stop(1);
    return await done;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--diagnostics') {
      const { inspectStorage } = await import('./storage-diagnostics.mjs');
      const databaseReady = process.env.DATABASE_PATH ? inspectStorage(process.env.DATABASE_PATH) : false;
      const state = await serviceStatus(configuration());
      diagnostic('services.health', state);
      process.exitCode = databaseReady && state.pii.status === 'ready' && state.site.status === 'ready' ? 0 : 1;
    } else if (args.length === 1 && args[0] === '--healthcheck') {
      process.exitCode = await healthy(configuration()) ? 0 : 1;
    } else {
      process.exitCode = await supervise(args[0] === '--' ? args.slice(1) : args);
    }
  } catch (error) {
    diagnostic('startup.failed', { phase: 'supervisor', errorCode: error?.code ?? 'UNKNOWN' }, 'error');
    process.exitCode = 1;
  }
}
