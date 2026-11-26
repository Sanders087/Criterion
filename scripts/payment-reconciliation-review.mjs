import { DatabaseSync } from 'node:sqlite';
import { reviewSql } from '../lib/payment-reconciliation.mjs';
import { validOperationId } from '../lib/request-context.mjs';

if (!process.env.DATABASE_PATH) throw new Error('Set DATABASE_PATH to the existing Criterion database');
const db=new DatabaseSync(process.env.DATABASE_PATH,{readOnly:true});
try {
  for (const row of db.prepare(reviewSql).iterate(Date.now())) {
    console.log(JSON.stringify({operationId:validOperationId('o_'+row.id)?'o_'+row.id:'invalid',
      attempts:Number(row.reconcile_attempts),lastCheckedAt:new Date(Number(row.checked_at)).toISOString()}));
  }
} finally { db.close(); }
