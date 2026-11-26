import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '../db/sqlite.mjs';
import { claimPaymentCheck, reconciliationConfig, releasePaymentCheck, readUnresolvedPaymentCount, reviewSql, runReconciliationBatch, unresolvedPaymentCount } from '../lib/payment-reconciliation.mjs';

const options={intervalMs:60_000,batch:2};
function seed(db,id,now) {
  db.prepare(`INSERT INTO documents(id,owner,title,kind,stage,body,created_at,updated_at,billing_state)
    VALUES(?,'test','fixture','services','draft','{}','2026-01-01','2026-01-01','unpaid')`).bind(id).run();
  db.prepare(`INSERT INTO payment_orders(id,document_id,owner,active_document,amount,terminal_key,status,created_at,updated_at)
    VALUES(?,?,'test',?,19900,'fixture','INIT_OUTCOME_UNKNOWN',?,?)`).bind(id,id,id,now-180000,now-180000).run();
}
function testFile(t) {
  const directory=mkdtempSync(join(tmpdir(),'criterion-reconcile-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  return join(directory,'test.sqlite');
}

test('reconciliation validates operator limits and supplies documented defaults',()=>{
  assert.deepEqual(reconciliationConfig({}),{intervalMs:60000,batch:20});
  assert.throws(()=>reconciliationConfig({PAYMENT_RECONCILIATION_BATCH_SIZE:1000}));
  assert.throws(()=>reconciliationConfig({PAYMENT_RECONCILIATION_INTERVAL_SECONDS:'NaN'}));
});

test('two database connections share the batch lease, per-order lease, and request budget',async t=>{
  const path=testFile(t),db=openDatabase(path),second=openDatabase(path);
  let now=1_000_000;
  const gate=Promise.withResolvers(),started=Promise.withResolvers(),ids=[randomUUID(),randomUUID(),randomUUID()].sort();
  const clock={now:()=>now,delay:async ms=>{now+=ms;}};
  const observed=[];
  try {
    ids.forEach(id=>seed(db,id,now));
    const batch=runReconciliationBatch(db,options,async id=>{
      observed.push([id,now]);
      if (observed.length===1) {started.resolve();await gate.promise;}
    },clock);
    await started.promise;
    assert.equal(claimPaymentCheck(second,ids[0],now+6000),false);
    assert.equal(await runReconciliationBatch(second,options,()=>assert.fail('duplicate process'),clock),0);
    gate.resolve();assert.equal(await batch,2);
    assert.deepEqual(observed,[[ids[0],1000000],[ids[1],1030000]]);
    assert.equal(unresolvedPaymentCount(db,now),3);
    assert.equal(await runReconciliationBatch(second,options,()=>assert.fail('budget'),clock),0);
  } finally { gate.resolve();db.close();second.close(); }
});

test('persistent attempts back off, survive restarts and become available for manual review after six checks',async t=>{
  const path=testFile(t),id=randomUUID();let now=1_000_000,db=openDatabase(path),calls=0;
  const clock={now:()=>now,delay:async()=>{}};
  try {
    seed(db,id,now);
    for (let attempt=1;attempt<=6;attempt++) {
      assert.equal(await runReconciliationBatch(db,options,()=>{calls++;throw Error('fixture');},clock),1);
      const data=db.prepare('SELECT reconcile_attempts,reconcile_next_at,reconcile_lease_until FROM payment_orders WHERE id=?').bind(id).first();
      assert.equal(data.reconcile_lease_until,0);assert.equal(data.reconcile_attempts,attempt);
      assert.equal(data.reconcile_next_at-now,60000*(2**(attempt-1)));
      db.close();db=openDatabase(path);
      now=data.reconcile_next_at-1;
      assert.equal(await runReconciliationBatch(db,options,()=>assert.fail('premature'),clock),0);
      now+=60001;
    }
    assert.equal(await runReconciliationBatch(db,options,()=>assert.fail('exhausted'),clock),0);
    assert.equal(calls,6);assert.equal(db.prepare(reviewSql).bind(now).all().results[0].id,id);
    const readOnly=new DatabaseSync(path,{readOnly:true});
    try { assert.equal(readUnresolvedPaymentCount(readOnly,now),1); } finally { readOnly.close(); }
    const lines=execFileSync(process.execPath,['--no-warnings','scripts/payment-reconciliation-review.mjs'],{
      encoding:'utf8',env:{DATABASE_PATH:path,SystemRoot:process.env.SystemRoot??''},
    }).trim();
    assert.deepEqual(JSON.parse(lines),{operationId:'o_'+id,attempts:6,lastCheckedAt:new Date(db.prepare('SELECT checked_at FROM payment_orders').first().checked_at).toISOString()});
    assert.equal(claimPaymentCheck(db,id,now),true);releasePaymentCheck(db,id,now);
  } finally { db.close(); }
});

test('an interrupted manual or automatic claim survives restart and expires without releasing a newer claim',t=>{
  const path=testFile(t),id=randomUUID(),now=1_000_000;let db=openDatabase(path);
  try {
    seed(db,id,now);assert.equal(claimPaymentCheck(db,id,now,10000),true);
    db.close();db=openDatabase(path);
    assert.equal(claimPaymentCheck(db,id,now+59999),false);
    assert.equal(claimPaymentCheck(db,id,now+60001),true);
    releasePaymentCheck(db,id,now);
    assert.equal(claimPaymentCheck(db,id,now+70000),false);
  } finally { db.close(); }
});
