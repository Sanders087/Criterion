import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitoringGauges } from '../lib/monitoring-gauges.mjs';

test('scraping a missing database cannot create the file or run migrations', t => {
  const directory = mkdtempSync(join(tmpdir(),'criterion-metrics-'));
  const databasePath = join(directory,'missing.sqlite');
  const previous = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = databasePath;
  t.after(() => {
    if (previous) process.env.DATABASE_PATH = previous;
    else delete process.env.DATABASE_PATH;
    rmSync(directory,{recursive:true,force:true});
  });
  const metrics = monitoringGauges();
  assert.equal(metrics.sqlite_available,0);
  assert.equal(metrics.payment_confirmed_without_access,null);
  assert.equal(existsSync(databasePath),false);
});
