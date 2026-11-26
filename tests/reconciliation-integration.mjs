import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { createFetchMock,createTestApp } from './node-app.mjs';

const terminal='fixtureDEMO', records=new Map(), calls=[], stateIds=[];
const mock=createFetchMock();
for (const method of ['CheckOrder','GetState','Init','Cancel']) {
  mock.get('https://securepay.tinkoff.ru').intercept({path:'/v2/'+method,method:'POST'}).reply(200,async request=>{
    const data=await new Response(request.body).json();calls.push(method);
    if (method==='GetState') {stateIds.push(data.PaymentId);return JSON.stringify(records.get(data.PaymentId));}
    if (method==='CheckOrder') return JSON.stringify({Success:true,ErrorCode:'0',TerminalKey:terminal,OrderId:data.OrderId,
      Payments:[...records.values()].filter(row=>row.OrderId===data.OrderId)});
    throw Error('Background reconciliation attempted a bank mutation');
  }).persist();
}
const app=await createTestApp({fetchMock:mock,bindings:{TBANK_ENABLED:'true',TBANK_TERMINAL_KEY:terminal,TBANK_PASSWORD:'fixture',PAYMENT_RECONCILIATION_ENABLED:'true',
  PAYMENT_RECONCILIATION_INTERVAL_SECONDS:'10',PAYMENT_RECONCILIATION_BATCH_SIZE:'10'}});
try {
  const db=app.database();
  function order(id,status,rank,options={}) {
    const document=randomUUID(),order=randomUUID(),time=Date.now()-(options.recent?0:180000);
    db.prepare(`INSERT INTO documents(id,owner,title,kind,stage,body,created_at,updated_at,billing_state)
      VALUES(?,'fixture','fixture','services','draft','{}','2026-01-01','2026-01-01','unpaid')`).bind(document).run();
    db.prepare(`INSERT INTO payment_orders(id,document_id,owner,active_document,amount,terminal_key,payment_id,status,status_rank,created_at,updated_at,notification_failed_at)
      VALUES(?,?,'fixture',?,19900,?,?,?,?,?,?,?)`).bind(order,document,document,terminal,options.unknown?null:id,status,rank,time,time,options.notificationFailed?time:0).run();
    records.set(id,{Success:true,ErrorCode:'0',TerminalKey:terminal,OrderId:order,PaymentId:id,Amount:19900,Status:options.bankStatus??'CONFIRMED'});
    return {document,order};
  }
  const unknown=order('100','INIT_OUTCOME_UNKNOWN',0,{unknown:true});
  const confirmed=order('101','CONFIRMED',20);
  const failed=order('102','AUTHORIZED',10,{notificationFailed:true,recent:true});
  const linkless=order('103','NEW',1,{bankStatus:'NEW'});
  const fresh=order('104','INIT_OUTCOME_UNKNOWN',0,{unknown:true,recent:true});
  const archived=order('105','CONFIRMED',20);
  db.prepare('DELETE FROM documents WHERE id=?').bind(archived.document).run();
  const paid=doc=>db.prepare('SELECT billing_state AS state FROM documents WHERE id=?').bind(doc.document).first().state==='paid';
  const deadline=Date.now()+24500;
  while (Date.now()<deadline && !(paid(unknown)&&paid(confirmed)&&paid(failed)&&calls.filter(m=>m==='GetState').length>=4&&db.prepare('SELECT reconcile_attempts n FROM payment_orders WHERE id=?').bind(linkless.order).first().n>0)) await sleep(100);
  assert.ok(paid(unknown)&&paid(confirmed)&&paid(failed),'Scheduled bank checks must grant access through verified existing orders');
  assert.equal(paid(linkless),false);assert.equal(paid(fresh),false);
  assert.equal(db.prepare('SELECT notification_failed_at n FROM payment_orders WHERE id=?').bind(failed.order).first().n,0);
  assert.equal(db.prepare('SELECT reconcile_attempts n FROM payment_orders WHERE id=?').bind(fresh.order).first().n,0);
  assert.equal(calls.filter(m=>m==='CheckOrder').length,1);assert.ok(calls.filter(m=>m==='GetState').length>=4);
  assert.equal(calls.filter(m=>m==='Init'||m==='Cancel').length,0);
  assert.equal(db.prepare('SELECT count(*) n FROM payment_orders').first().n,6);
  assert.ok(!stateIds.includes('105'),'Deleted paid documents must not trigger a bank request');
  console.log('Reconciliation integration passed: 4 existing orders checked, 3 paid documents restored, no bank mutations.');
} finally { await app.dispose(); }
