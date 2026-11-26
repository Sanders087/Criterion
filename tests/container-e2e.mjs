import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const image = process.env.CRITERION_TEST_IMAGE || 'criterion:docker';
const suffix = randomBytes(6).toString('hex'), name = 'criterion-check-' + suffix, volume = name + '-data';
const env = { ...process.env, PII_ANALYZER_TOKEN: randomBytes(32).toString('hex'), MONITORING_TOKEN: randomBytes(32).toString('hex') };
function docker(args, check = true) {
  if (args[0] === 'exec') args = ['exec', '--user', '10001:10001', ...args.slice(1)];
  const result = spawnSync('docker', args, { encoding: 'utf8', env, windowsHide: true, timeout: 120000 });
  if (check && (result.error || result.status !== 0)) throw new Error('Docker ' + args[0] + ' failed: ' + (result.stderr || result.error));
  return result;
}
let created = false;
try {
  docker(['volume', 'create', volume]);
  const launch = () => docker(['run', '-d', '--name', name, '--network', 'none', '--read-only', '--memory', '1536m', '--cpus', '2',
    '--tmpfs', '/tmp:rw,nosuid,size=64m', '--mount', 'type=volume,source=' + volume + ',target=/data',
    '--mount', 'type=bind,source=' + fileURLToPath(new URL('./', import.meta.url)) + ',target=/app/tests,readonly',
    '-e', 'MONITORING_TOKEN', '-e', 'PII_ANALYZER_TOKEN', '-e', 'AUTH_PUBLIC_URL=https://criterion.test', '-e', 'OPENAI_API_KEY=fixture-only',
    image, 'node', 'scripts/run-with-pii.mjs', '--', 'node', '--import', 'file:///app/tests/container-provider.mjs', 'scripts/start-site.mjs', 'server.js']);
  launch();
  created = true;
  async function ready() {
    for (let i = 0; i < 70; i++) {
      if (docker(['exec', name, 'node', 'scripts/run-with-pii.mjs', '--healthcheck'], false).status === 0) return;
      if (docker(['inspect', '--format', '{{.State.Running}}', name]).stdout.trim() !== 'true') break;
      await delay(1000);
    }
    throw new Error('Container not ready: ' + docker(['logs', name], false).stderr);
  }
  await ready();
  const rawLogs=docker(['logs',name]);
  const events=(rawLogs.stdout+'\n'+rawLogs.stderr).split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
  const bootstrap = events.find(e => e.event === 'storage.entrypoint' && e.phase === 'before_permissions');
  assert.ok(bootstrap);
  for (const expected of ['level=info', 'service=criterion', 'databasePath=/data/criterion.sqlite',
    'directory.uid=' + bootstrap.directory.uid, 'directory.mode=' + bootstrap.directory.mode]) {
    assert.ok(bootstrap.message.split(' ').includes(expected));
  }
  // A startup that fails before Node runs must still expose a safe OS error number in the viewer.
  const failed = docker(['run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/data', image, '/missing-test-command'], false);
  assert.equal(failed.status, 1);
  const failure = failed.stderr.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    .find(e => e.event === 'entrypoint.failed');
  assert.equal(failure.errno, 2);
  assert.ok(failure.message.includes('errno=2'));
  assert.doesNotMatch(failure.message, /missing-test-command/);
  const storage=events.find(e=>e.event==='storage.snapshot'&&e.phase==='after_open');
  assert.equal(storage.databasePath,'/data/criterion.sqlite');
  assert.equal(storage.mount.mountPoint,'/data');assert.equal(storage.mount.separateMount,true);
  assert.equal(storage.mount.persistenceVerified,false);assert.equal(storage.database.uid,10001);
  assert.ok(events.some(e=>e.event==='database.ready'&&e.queryOk&&e.databasePath==='/data/criterion.sqlite'));
  assert.ok(!rawLogs.stdout.includes(env.PII_ANALYZER_TOKEN));
  assert.ok(!rawLogs.stderr.includes(env.PII_ANALYZER_TOKEN));
  assert.match(docker(['exec',name,'node','scripts/run-with-pii.mjs','--diagnostics']).stdout,/database.inspection/);
  console.log('Storage diagnostics: actual SQLite file and /data mount verified; no secrets in events.');
  assert.equal(docker(['exec', name, 'node', '-p', "require('fs').statSync('/proc/1').uid"]).stdout.trim(), '10001');
  console.log(docker(['exec', name, 'python', 'scripts/check-pii-endpoint.py', '--url', 'http://127.0.0.1:8100/analyze']).stdout.trim());
  console.log(docker(['exec', name, 'node', '/app/tests/container-client.mjs']).stdout.trim());
  const pythonSuite = docker(['exec',name,'python','-B','-m','unittest','discover','-s','/app/tests','-p','test_backup_restore.py']);
  console.log(pythonSuite.stderr.trim());
  const backup = docker(['exec', name, 'python', 'scripts/backup-db.py']).stdout.trim();
  assert.match(backup, /^\/data\/backups\/criterion-[0-9TZ]+\.sqlite$/);
  docker(['exec',name,'python','scripts/backup-db.py','--restore',backup,'--to','/tmp/criterion-recovered.sqlite']);
  console.log(docker(['exec',name,'node','/app/tests/container-monitoring.mjs']).stdout.trim());
  docker(['stop','--time','15',name]);
  const original = docker(['logs',name]);
  docker(['rm',name]);
  created = false;
  launch();
  created = true;
  await ready();
  console.log(docker(['exec', name, 'node', '/app/tests/container-client.mjs', '--persisted']).stdout.trim());
  docker(['stop', '--time', '15', name]);
  assert.equal(docker(['inspect', '--format', '{{.State.ExitCode}}', name]).stdout.trim(), '0');
  const combined = docker(['logs', name]);
  const transcript = [original.stdout,original.stderr,combined.stdout,combined.stderr].join('\n');
  const synthetic = JSON.parse(readFileSync(new URL('./fixtures/pii-office-services-case.json', import.meta.url), 'utf8'));
  assert.equal(synthetic.syntheticOnly, true);
  // Four-digit passport series alone can occur in random request IDs. Check them in context.
  const markers = [
    'docker@example.test', 'Synthetic-Docker-Password-2026', env.PII_ANALYZER_TOKEN, env.MONITORING_TOKEN, 'CRITERION_PII',
    synthetic.text.split('\n')[0], ...synthetic.text.match(/серия \d+, номер \d+/gu),
    ...synthetic.sensitive.map(span => span.text).filter(value => !/^\d{1,8}$/.test(value)),
  ];
  for (const marker of markers) assert.ok(!transcript.includes(marker), 'Synthetic private data in runtime logs');
  console.log('Combined site, supervisor and detector logs contain no synthetic account, contract or PII markers.');
  console.log('Container SIGTERM exit=0; test network disabled; all runtime processes run without root.');
} catch (error) {
  if (created) {
    const logs=docker(['logs',name],false);
    console.error((logs.stdout+'\n'+logs.stderr).slice(-10000));
  }
  throw error;
} finally {
  if (created) docker(['rm', '-f', name], false);
  docker(['volume', 'rm', volume], false);
}
