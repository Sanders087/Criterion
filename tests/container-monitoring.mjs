import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
const base = 'http://127.0.0.1:3000';
for (const path of ['/api/health/live','/api/health/ready']) assert.equal((await fetch(base+path)).status,200);
const headers = {Authorization:'Bearer '+process.env.MONITORING_TOKEN};
const internal = await fetch(base+'/api/health/integrations',{headers});
assert.equal(internal.status,200);
const metrics = await fetch(base+'/api/metrics',{headers});
assert.equal(metrics.status,200);
assert.match(await metrics.text(),/backup_last_success_timestamp_seconds [1-9][0-9]*/);
const restored = new DatabaseSync('/tmp/criterion-recovered.sqlite',{readOnly:true});
try {
  assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.ok(restored.prepare('SELECT count(*) AS n FROM documents').get().n > 0);
  assert.ok(restored.prepare('SELECT count(*) AS n FROM sessions').get().n > 0);
} finally { restored.close(); }
console.log('Isolated runtime: live and ready HTTP, private metrics, verified backup and restored data.');
