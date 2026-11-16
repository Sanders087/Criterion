// One Linux container: trusted loopback detector + the team's Node.js server.
// No shell commands, request-body logging, or fallback around PII protection.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const endpoint = 'http://127.0.0.1:8100/analyze';
export function configuration(env = process.env) {
  if (!/^[\x21-\x7e]{32,256}$/.test(env.PII_ANALYZER_TOKEN || '')) {
    throw new Error('Set PII_ANALYZER_TOKEN to 32–256 printable ASCII characters without spaces.');
  }
  if (env.PII_ANALYZER_URL && env.PII_ANALYZER_URL !== endpoint) {
    throw new Error('The shared container requires PII_ANALYZER_URL=' + endpoint);
  }
  const port = env.PORT || '3000';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || Number(port) === 8100) {
    throw new Error('PORT must be a valid site port other than 8100.');
  }
  const healthPath = env.SITE_HEALTH_PATH || '/';
  if (!/^\/(?!\/)[a-zA-Z0-9/_-]*$/.test(healthPath)) throw new Error('Invalid SITE_HEALTH_PATH.');
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

export async function healthy(config, includeSite = true) {
  try {
    const pii = await fetch('http://127.0.0.1:8100/health', {
      headers: { Authorization: 'Bearer ' + config.piiEnv.PII_ANALYZER_TOKEN },
      redirect: 'manual', signal: AbortSignal.timeout(2000),
    });
    const piiOk = pii.status === 200 && (await pii.json()).status === 'ready';
    if (!piiOk) return false;
    if (!includeSite) return true;
    const site = await fetch(config.siteHealth, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
    await site.body?.cancel();
    return site.status >= 200 && site.status < 400;
  } catch { return false; }
}

// The optional command override supports isolated process-lifecycle tests.
// Production CLI always uses the real Python ASGI service.
export async function supervise(siteCommand, { env = process.env, piiCommand } = {}) {
  const config = configuration(env);
  if (!Array.isArray(siteCommand) || !siteCommand.length || siteCommand.some(x => typeof x !== 'string' || !x)) {
    throw new Error('Usage: node scripts/run-with-pii.mjs -- node path/to/server.js');
  }
  const children = [];
  let stopping = false;
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
  const onTerm = () => { void stop(0); };
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onTerm);
  function launch(command, childEnv, name) {
    const child = spawn(command[0], command.slice(1), {
      env: childEnv, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
      detached: process.platform !== 'win32',
    });
    children.push(child);
    child.once('error', () => {
      console.error('Criterion: failed to start ' + name + '.');
      void stop(1);
    });
    child.once('exit', () => {
      if (!stopping) {
        console.error('Criterion: ' + name + ' stopped; shutting down the container.');
        void stop(1);
      }
    });
    return child;
  }
  try {
    launch(piiCommand || [env.PII_PYTHON || 'python', '-m', 'uvicorn', 'services.pii.app:create_app',
      '--factory', '--host', '127.0.0.1', '--port', '8100', '--workers', '1',
      '--no-access-log', '--limit-concurrency', '4'], config.piiEnv, 'PII detector');
    const deadline = Date.now() + 90_000;
    while (!stopping && !(await healthy(config, false))) {
      if (Date.now() >= deadline) {
        console.error('Criterion: PII detector readiness timed out.');
        await stop(1);
        break;
      }
      await delay(250);
    }
    if (!stopping) {
      console.log('Criterion: PII detector ready; starting site.');
      launch(siteCommand, config.siteEnv, 'site');
    }
    return await done;
  } catch {
    console.error('Criterion: startup failed.');
    await stop(1);
    return await done;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--healthcheck') {
      process.exitCode = await healthy(configuration()) ? 0 : 1;
    } else {
      process.exitCode = await supervise(args[0] === '--' ? args.slice(1) : args);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
