import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { diagnostic, safeErrorCode } from './diagnostics.mjs';
import { runOperation, runRequestContext } from './request-context.mjs';

const MAX_ATTEMPTS = 6;
const STALE_MS = 120_000;
const LEASE_MS = 60_000; // The shared bank request deadline is 15 seconds.
const joined = ' FROM payment_orders o JOIN documents d ON d.id=o.document_id AND d.owner=o.owner ';
const incomplete = `(o.notification_failed_at>0 OR
  (o.status IN ('CONFIRMED','PARTIAL_REFUNDED') AND d.billing_state NOT IN ('paid','legacy')) OR
  (o.active_document IS NOT NULL AND o.status_rank<20 AND o.status<>'INIT_FAILED'))`;
const aged = `(o.notification_failed_at>0 OR o.status IN ('CONFIRMED','PARTIAL_REFUNDED') OR o.updated_at<=?)`;

const countSql='SELECT count(*) AS n'+joined+'WHERE '+incomplete+' AND '+aged;
export function unresolvedPaymentCount(db, now=Date.now()) {
  return Number(db.prepare(countSql).bind(now-STALE_MS).first().n);
}
export function readUnresolvedPaymentCount(native,now=Date.now()) {
  return Number(native.prepare(countSql).get(now-STALE_MS).n);
}

// The CLI uses a read-only native SQLite connection, even when the application is stopped.
export const reviewSql = `SELECT o.id,o.status,o.reconcile_attempts,o.checked_at ${joined}
  WHERE ${incomplete} AND o.reconcile_attempts>=${MAX_ATTEMPTS} AND o.reconcile_lease_until<=?
  ORDER BY o.checked_at,o.id`;

export function reconciliationConfig(env) {
  const interval = Number(env.PAYMENT_RECONCILIATION_INTERVAL_SECONDS ?? 60);
  const batch = Number(env.PAYMENT_RECONCILIATION_BATCH_SIZE ?? 20);
  if (!Number.isInteger(interval) || interval<10 || interval>3600 || !Number.isInteger(batch) || batch<1 || batch>50)
    throw new RangeError('Invalid payment reconciliation limits');
  return { intervalMs: interval*1000, batch };
}

export function claimPaymentCheck(db,id,now,autoInterval=0) {
  const leaseUntil=now+LEASE_MS;
  if (!autoInterval) return db.prepare(`UPDATE payment_orders SET checked_at=?,reconcile_lease_until=? WHERE id=?
    AND reconcile_lease_until<=? AND checked_at<?`).bind(now,leaseUntil,id,now,now-5000).run().meta.changes===1;
  // Reserve both the lease and this attempt before contacting the bank, including across a crash.
  return db.prepare(`UPDATE payment_orders SET checked_at=?,reconcile_lease_until=?,reconcile_attempts=reconcile_attempts+1,
    reconcile_next_at=?+MIN(3600000,?*(1 << reconcile_attempts)) WHERE id=? AND reconcile_lease_until<=? AND checked_at<?
    AND reconcile_attempts<? AND reconcile_next_at<=? AND id IN (SELECT o.id ${joined} WHERE o.id=? AND ${incomplete} AND ${aged})`)
    .bind(now,leaseUntil,now,autoInterval,id,now,now-5000,MAX_ATTEMPTS,now,id,now-STALE_MS).run().meta.changes===1;
}

export function releasePaymentCheck(db,id,now) {
  db.prepare('UPDATE payment_orders SET reconcile_lease_until=0 WHERE id=? AND checked_at=?').bind(id,now).run();
}

export async function runReconciliationBatch(db,config,readBankState,{now=Date.now,delay=sleep}={}) {
  const {batch,intervalMs}=config, start=now(), token=randomUUID();
  const gap=Math.max(1000,Math.floor(intervalMs/batch));
  const expires=start+LEASE_MS;
  const locked=db.prepare(`INSERT INTO payment_reconciliation_clock (id,token,available_at) VALUES (1,?,?)
    ON CONFLICT(id) DO UPDATE SET token=excluded.token,available_at=excluded.available_at WHERE available_at<=?`)
    .bind(token,expires,start).run().meta.changes;
  if (!locked) return 0;
  let processed=0;
  try {
    const rows=db.prepare(`SELECT o.id ${joined} WHERE ${incomplete} AND ${aged} AND o.reconcile_attempts<?
      AND o.reconcile_next_at<=? AND o.reconcile_lease_until<=? AND o.checked_at<?
      ORDER BY o.reconcile_next_at,o.updated_at,o.id LIMIT ?`)
      .bind(start-STALE_MS,MAX_ATTEMPTS,start,start,start-5000,batch).all().results;
    for (const row of rows) {
      // Extend only for the next local wait and one network deadline. A stopped
      // worker cannot hold the whole batch for the remainder of its original size.
      const before=now(),wait=processed?gap:0;
      const owner=db.prepare('UPDATE payment_reconciliation_clock SET available_at=? WHERE id=1 AND token=? AND available_at>?')
        .bind(before+wait+LEASE_MS,token,before).run().meta.changes;
      if (!owner) break;
      if (wait) await delay(wait);
      const claimedAt=now();
      if (claimedAt>=before+wait+LEASE_MS) break;
      if (!claimPaymentCheck(db,row.id,claimedAt,intervalMs)) continue;
      processed++;
      const attempt=db.prepare('SELECT reconcile_attempts AS attempts FROM payment_orders WHERE id=?').bind(row.id).first().attempts;
      await runRequestContext(undefined,()=>runOperation(async()=>{
        let failed=false;
        try { await readBankState(row.id,claimedAt); }
        catch { failed=true; } // The bank check logs its own bounded failure classification.
        finally { releasePaymentCheck(db,row.id,claimedAt); }
        const pending=db.prepare(`SELECT o.reconcile_attempts AS attempts ${joined} WHERE o.id=? AND ${incomplete}`).bind(row.id).first();
        const result=!pending?'resolved':pending.attempts>=MAX_ATTEMPTS?'manual_review':failed?'failed':'pending';
        if (!pending) db.prepare('UPDATE payment_orders SET reconcile_attempts=0,reconcile_next_at=0 WHERE id=? AND checked_at=?').bind(row.id,claimedAt).run();
        diagnostic('payment.reconciliation_result',{result,attempt},result==='manual_review'?'warn':'info');
      },'o_'+row.id));
    }
  } finally {
    db.prepare('UPDATE payment_reconciliation_clock SET available_at=? WHERE id=1 AND token=?')
      .bind(Math.max(start+intervalMs,now()+1000),token).run();
  }
  return processed;
}

export function startReconciliation(db,config,readBankState) {
  const key=Symbol.for('criterion.payment-reconciliation.timer');
  if (globalThis[key]) return;
  const tick=async()=>{
    try { await runReconciliationBatch(db(),config,readBankState); }
    catch(cause) { diagnostic('payment.reconciliation_failed',{errorCode:safeErrorCode(cause)},'error'); }
    finally { globalThis[key]=setTimeout(tick,config.intervalMs).unref(); }
  };
  globalThis[key]=setTimeout(tick,1000).unref();
}
