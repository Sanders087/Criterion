import {env} from '../runtime';
import {diagnostic} from '../diagnostics.mjs';
import {SITE_MS} from '../payment-network.mjs';
import {and,eq} from 'drizzle-orm';
import {getDb} from '../../db';
import {documents} from '../../db/schema';
import {CONTRACT_PRICE,hasAccess,presentContract} from './billing';
import {runtime,HttpError} from './server';
import {digest} from './auth';
import {normalizeError} from './app-error';
import {withPaymentOrder,bankConfig,checkoutConfig,bankRequest,initParameters,paymentUrl,PaymentError,bankId,bankAmount,BANK_RANK,FAILED_BANK_STATUSES,successfulBankResponse,type BankData} from './tbank';

type Order={id:string;document_id:string;owner:string;active_document:string|null;amount:number;terminal_key:string;payment_id:string|null;payment_url:string|null;status:string;status_rank:number;created_at:number;checked_at:number;first_missing_at:number;cancel_requested_at:number};
const database=()=>env.DB!;
export async function ownedDocument(id:string,owner:string){
  const [row]=await getDb().select().from(documents).where(and(eq(documents.id,id),eq(documents.owner,owner)));
  if(!row)throw new HttpError(404,'Документ не найден.');return row;
}
type DocumentRow = Awaited<ReturnType<typeof ownedDocument>>;

export async function presentPaymentDocument(row:DocumentRow, owner:string) {
  const document = presentContract(row);
  if (row.owner !== owner || !document.billing?.locked) return document;
  const pending = database().prepare(`SELECT id FROM payment_orders WHERE active_document=? AND owner=?
    AND payment_url IS NULL AND status NOT IN ('INIT_FAILED','CANCELED','DEADLINE_EXPIRED','REJECTED','REVERSED','REFUNDED')`).bind(row.id,owner).first();
  if (pending) document.billing.checkRequired = true;
  return document;
}

function checkRequired(status:number, cause?:unknown) {
  return new PaymentError(status,'Результат оплаты уточняется. Нажмите «Проверить оплату».',
    {code:'PAYMENT_CHECK_REQUIRED',stage:'reconciliation',retryable:false,cause});
}

async function latestOrder(id:string,owner:string){return database().prepare('SELECT * FROM payment_orders WHERE document_id=? AND owner=? ORDER BY created_at DESC LIMIT 1').bind(id,owner).first<Order>()}
async function orderById(id:string){return database().prepare('SELECT * FROM payment_orders WHERE id=?').bind(id).first<Order>()}

/** Called only after token verification or a direct authenticated bank API response. */
export async function applyBankState(data:BankData, source:'bank_response'|'notification'='bank_response'){
  const started = performance.now();
  const order = typeof data.OrderId === 'string' ? await orderById(data.OrderId) : null;
  if (!order) {
    if (source === 'notification') diagnostic('payment.notification_rejected',{reason:'unknown_order'},'warn');
    throw new PaymentError(404,'Заказ не найден.');
  }
  return withPaymentOrder(order.id,async () => {
    const notification = source === 'notification';
    if (notification) diagnostic('payment.notification_received');
    const reject = (reason:string, message:string):never => {
      if (notification) diagnostic('payment.notification_rejected',{reason},'warn');
      throw new PaymentError(400,message);
    };
    const paymentId = bankId(data.PaymentId), amount = bankAmount(data.Amount), status = data.Status;
    if (!paymentId || amount === null || typeof status !== 'string') return reject('invalid_format','Неверный формат уведомления об оплате.');
    if (data.TerminalKey !== order.terminal_key || data.TerminalKey !== bankConfig(runtime()).terminalKey)
      return reject('unknown_terminal','Платёж не соответствует заказу.');
    const refund = status === 'REFUNDED' || status === 'PARTIAL_REFUNDED';
    if ((refund || FAILED_BANK_STATUSES.includes(status)) ? amount < 0 || amount > order.amount : amount !== order.amount)
      return reject('amount_mismatch','Сумма платежа не соответствует заказу.');
    if ((refund || status === 'CONFIRMED') && !successfulBankResponse(data))
      return reject('payment_not_confirmed','Банк не подтвердил операцию.');
    if (!Object.hasOwn(BANK_RANK,status)) {
      if (notification) diagnostic('payment.notification_rejected',{reason:'unsupported_status'},'warn');
      return;
    }
    let grantPhase = false;
    const db = database();
    try {
      const outcome = db.writeTransaction(() => {
        const current = db.prepare('SELECT * FROM payment_orders WHERE id=?').bind(order.id).first<Order>();
        if (!current) throw new Error('Order disappeared');
        if (current.payment_id && current.payment_id !== paymentId) return {kind:'mismatch'};
        const wasPaid = ['CONFIRMED','PARTIAL_REFUNDED','REFUNDED'].includes(current.status);
        if (current.status_rank > BANK_RANK[status] || (wasPaid && !refund && status !== 'CONFIRMED') ||
            (FAILED_BANK_STATUSES.includes(current.status) && current.status !== status))
          return {kind:'stale'};
        const changed = current.status !== status;
        if (changed || !current.payment_id) {
          db.prepare(`UPDATE payment_orders SET payment_id=?,status=?,status_rank=?,updated_at=?,first_missing_at=0,
            active_document=CASE WHEN ? THEN NULL ELSE active_document END WHERE id=?`)
            .bind(paymentId,status,BANK_RANK[status],Date.now(),FAILED_BANK_STATUSES.includes(status)?1:0,current.id).run();
        }
        const added = db.prepare('INSERT OR IGNORE INTO payment_events (id,order_id,status,amount,created_at) VALUES (?,?,?,?,?)')
          .bind(crypto.randomUUID(),current.id,status,amount,Date.now()).run().meta.changes;
        let granted = false;
        if (status === 'CONFIRMED' || status === 'PARTIAL_REFUNDED') {
          grantPhase = true;
          granted = db.prepare("UPDATE documents SET billing_state='paid' WHERE id=? AND owner=? AND billing_state='unpaid'")
            .bind(current.document_id,current.owner).run().meta.changes === 1;
          const doc = db.prepare('SELECT billing_state FROM documents WHERE id=? AND owner=?').bind(current.document_id,current.owner).first();
          if (!doc || !hasAccess(String(doc.billing_state))) throw new Error('Access update incomplete');
        } else if (status === 'REFUNDED') {
          db.prepare("UPDATE documents SET billing_state='refunded' WHERE id=? AND owner=? AND billing_state IN ('unpaid','paid')")
            .bind(current.document_id,current.owner).run();
        }
        return {kind:'applied',previousStatus:current.status,changed,duplicate:added===0,granted};
      });
      if (outcome.kind === 'mismatch') return reject('payment_mismatch','Платёж не соответствует заказу.');
      if (outcome.kind === 'stale') {
        if (notification) diagnostic('payment.notification_rejected',{reason:'stale_status'},'warn');
        return;
      }
      if (outcome.changed) diagnostic('payment.status_changed',{previousStatus:outcome.previousStatus,status});
      if (notification && outcome.duplicate) diagnostic('payment.notification_duplicate',{status});
      if (outcome.granted) diagnostic('payment.access_granted');
      if (notification) diagnostic('operation.completed',{component:'payments',stage:'notification',durationMs:Math.round(performance.now()-started)});
    } catch(cause) {
      if (cause instanceof PaymentError) throw cause;
      if (grantPhase) diagnostic('payment.access_grant_failed',{errorCode:'PAYMENT_ACCESS_ERROR',retryable:false},'error');
      if (notification) diagnostic('payment.notification_rejected',{reason:grantPhase?'access_grant':'database',errorCode:normalizeError(cause).code},'error');
      throw cause;
    }
  });
}

async function reconcile(order:Order, deadline:number){
  const request = (method:'GetState'|'Cancel'|'CheckOrder', params:BankData) =>
    bankRequest(runtime(),method,params,deadline);
  if(order.terminal_key!==bankConfig(runtime()).terminalKey)throw new PaymentError(503,'Проверка этого платежа временно недоступна. Обратитесь в поддержку.');
  const now=Date.now();
  if (['INITIALIZING','INIT_OUTCOME_UNKNOWN'].includes(order.status) && order.created_at>now-30000) return;
  const claim=await database().prepare('UPDATE payment_orders SET checked_at=? WHERE id=? AND checked_at<?').bind(now,order.id,now-5000).run();
  if(claim.meta.changes!==1)return;
  // The process can stop after dispatching Init and before recording its outcome.
  if (order.status==='INITIALIZING') {
    const changed = database().prepare(`UPDATE payment_orders SET status='INIT_OUTCOME_UNKNOWN',updated_at=?
      WHERE id=? AND status='INITIALIZING' AND checked_at=? AND payment_id IS NULL`).bind(now,order.id,now).run().meta.changes;
    if (changed) {
      diagnostic('payment.status_changed',{previousStatus:'INITIALIZING',status:'INIT_OUTCOME_UNKNOWN'});
      diagnostic('payment.init_outcome_unknown',{errorCode:'PAYMENT_CHECK_REQUIRED',retryable:false},'warn');
      order={...order,status:'INIT_OUTCOME_UNKNOWN'};
    }
  }
  let paymentId=order.payment_id;
  if(!paymentId){
    // Recover an Init whose HTTP response was lost; never blindly create a second payment.
    const result=await request('CheckOrder',{OrderId:order.id});
    // Bank error 335 explicitly means this OrderId does not exist on this terminal.
    // Wait beyond the request timeout and release only a never-initialized order.
    // Unknown errors, existing payment IDs and concurrent notifications stay closed.
    if(result.Success===false && String(result.ErrorCode)==='335') {
      const db = database();
      const contradictory = (result.OrderId !== undefined && result.OrderId !== order.id) ||
        (result.TerminalKey !== undefined && result.TerminalKey !== order.terminal_key) ||
        result.PaymentId !== undefined || result.PaymentURL !== undefined ||
        (result.Payments !== undefined && (!Array.isArray(result.Payments) || result.Payments.length !== 0));
      if (contradictory) {
        db.prepare('UPDATE payment_orders SET first_missing_at=0 WHERE id=? AND checked_at=?').bind(order.id,now).run();
        throw checkRequired(502);
      }
      if (order.created_at >= now-120000 || order.payment_url) return;
      const released = db.prepare(`UPDATE payment_orders SET status='INIT_FAILED',active_document=NULL,updated_at=?
        WHERE id=? AND status IN ('INITIALIZING','INIT_OUTCOME_UNKNOWN') AND status_rank=0 AND payment_id IS NULL
        AND payment_url IS NULL AND first_missing_at>0 AND first_missing_at<=? AND checked_at=?`)
        .bind(now,order.id,now-30000,now).run().meta.changes;
      if (released) diagnostic('payment.status_changed',{previousStatus:order.status,status:'INIT_FAILED'});
      else db.prepare(`UPDATE payment_orders SET first_missing_at=? WHERE id=? AND checked_at=?
        AND first_missing_at=0 AND status_rank=0 AND active_document IS NOT NULL`).bind(now,order.id,now).run();
      return;
    }
    database().prepare('UPDATE payment_orders SET first_missing_at=0 WHERE id=? AND checked_at=?').bind(order.id,now).run();
    if(!successfulBankResponse(result)) throw new PaymentError(502,'Не удалось проверить оплату в банке.',
      {code:'BANK_REQUEST_REJECTED',stage:'reconciliation'});
    if(result.OrderId!==order.id || result.TerminalKey!==order.terminal_key || !Array.isArray(result.Payments) || result.Payments.length!==1)
      throw checkRequired(502);
    paymentId=bankId((result.Payments[0] as BankData)?.PaymentId);
    if(!paymentId)throw checkRequired(502);
  }
  const result=await request('GetState',{PaymentId:paymentId});
  if(!successfulBankResponse(result))throw new PaymentError(502,'Не удалось проверить оплату в банке. Повторите проверку позже.',{code:'BANK_REQUEST_REJECTED',stage:'bank_request'});
  // Validate the exact ID requested as well as the immutable order/amount.
  if(result.OrderId!==order.id||bankId(result.PaymentId)!==paymentId)throw new PaymentError(502,'Ответ банка не соответствует платежу.');
  await applyBankState(result);
  // If Init's response was lost, the customer never received a payment link.
  // Only an untouched NEW payment may be cancelled automatically. A new order
  // is allowed only after GetState confirms that the old payment is closed.
  const current=await orderById(order.id);
  if(current&&!current.payment_url&&current.status==='NEW'&&current.created_at<now-30000){
    const reserved = database().prepare(`UPDATE payment_orders SET cancel_requested_at=?
      WHERE id=? AND status='NEW' AND cancel_requested_at=0 AND payment_url IS NULL AND payment_id=?`)
      .bind(Date.now(),order.id,paymentId).run().meta.changes;
    if (!reserved) return;
    const cancelled=await request('Cancel',{PaymentId:paymentId});
    if(!successfulBankResponse(cancelled))throw new PaymentError(502,'Не удалось подтвердить отмену платежа. Проверьте оплату позже.',{code:'BANK_REQUEST_REJECTED',stage:'reconciliation'});
    const finalState=await request('GetState',{PaymentId:paymentId});
    if(!successfulBankResponse(finalState)||finalState.OrderId!==order.id||bankId(finalState.PaymentId)!==paymentId)throw new PaymentError(502,'Статус платежа пока уточняется.');
    await applyBankState(finalState);
  }
}

async function checkOrder(order:Order, deadline:number) {
  try {
    await reconcile(order, deadline);
    const current = await orderById(order.id);
    diagnostic('payment.status_checked',{status:current?.status});
  } catch(cause) {
    diagnostic('payment.reconciliation_failed',{errorCode:normalizeError(cause).code},'error');
    throw cause;
  }
}

export async function checkout(documentId:string,owner:string,email:string){
  const deadline = performance.now()+SITE_MS;
  const row=await ownedDocument(documentId,owner);
  if(hasAccess(row.billingState))return {document:presentContract(row),paymentUrl:null};
  if(row.billingState==='refunded')throw new PaymentError(409,'Оплата этого договора возвращена. Обратитесь в поддержку.');
  if(!JSON.parse(row.body).sections?.length)throw new PaymentError(409,'Сначала завершите интервью и создайте черновик.');
  if(row.lockUntil&&row.lockUntil>Date.now())throw new PaymentError(409,'Дождитесь завершения текущего действия.');
  const config=checkoutConfig(runtime());
  const existing=await database().prepare('SELECT * FROM payment_orders WHERE active_document=? AND owner=?').bind(documentId,owner).first<Order>();
  if(existing){
    return withPaymentOrder(existing.id,async()=>{
      diagnostic('payment.checkout_started');
      await checkOrder(existing,deadline);
      const order=(await orderById(existing.id))!;
      const current=await ownedDocument(documentId,owner);
      if(hasAccess(current.billingState))return {document:presentContract(current),paymentUrl:null};
      // A request that started by recovering an earlier checkout only resolves that order.
      // An explicit later checkout may start a fresh payment after confirmed closure.
      if(!order.active_document)throw new PaymentError(409,'Предыдущий платёж закрыт. Вы можете начать новую оплату.');
      if(order.status==='REFUNDED')throw new PaymentError(409,'Оплата возвращена. Обратитесь в поддержку.');
      const url=paymentUrl(order.payment_url);
      if(!url)throw checkRequired(409);
      return {document:presentContract(current),paymentUrl:url};
    });
  }
  const id=crypto.randomUUID();
  return withPaymentOrder(id,()=>createPayment(id,documentId,owner,email,config.terminalKey,deadline));
}

async function createPayment(id:string,documentId:string,owner:string,email:string,terminalKey:string,deadline:number){
  const now=Date.now();
  // Prepare parameters before reserving the order, so bad receipt config cannot strand it.
  diagnostic('payment.checkout_started');
  const params=initParameters(runtime(),id,documentId,email);
  const limitKey=await digest('payment-init:'+owner);
  const attempts=await database().prepare('INSERT INTO auth_limits (key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count,expires_at').bind(limitKey,now+600000,now,now).first<{count:number;expires_at:number}>();
  if(attempts && attempts.count>10) {
    const error = new PaymentError(429,'Слишком много попыток оплаты. Повторите позже.',{code:'RATE_LIMITED',stage:'checkout'});
    error.retryAfterSeconds = Math.max(1,Math.ceil((attempts.expires_at-now)/1000));
    diagnostic('rate_limit.exceeded',{limitType:'payment_order',retryAfterSeconds:error.retryAfterSeconds},'warn');
    throw error;
  }
  const created=await database().prepare("INSERT OR IGNORE INTO payment_orders (id,document_id,owner,active_document,amount,terminal_key,status,status_rank,created_at,updated_at,checked_at) SELECT ?,id,owner,id,?,?,'INITIALIZING',0,?,?,0 FROM documents WHERE id=? AND owner=? AND billing_state='unpaid' AND (lock_until IS NULL OR lock_until<?)")
    .bind(id,CONTRACT_PRICE,terminalKey,now,now,documentId,owner,now).run();
  if(created.meta.changes!==1)throw new PaymentError(409,'Платёж уже создаётся. Нажмите «Проверить оплату».');
  diagnostic('payment.order_created');
  diagnostic('payment.init_started');
  const started = performance.now();
  let result:BankData;
  let definitive = false;
  try {
    result=await bankRequest(runtime(),'Init',params,deadline);
    if(!successfulBankResponse(result)){
      // Documented request validation errors, before acceptance. Internal errors,
      // duplicate IDs (20) and unrecognised codes still require CheckOrder.
      definitive = ['12','64'].includes(String(result.ErrorCode)) &&
        result.PaymentId === undefined && result.PaymentURL === undefined &&
        (result.TerminalKey === undefined || result.TerminalKey === terminalKey) && (result.OrderId === undefined || result.OrderId === id);
      throw new PaymentError(502,'Банк отклонил параметры платежа.',{code:'BANK_REQUEST_REJECTED',stage:'init',retryable:false});
    }
    if(result.OrderId!==id || result.TerminalKey!==terminalKey || bankAmount(result.Amount)!==CONTRACT_PRICE ||
        !bankId(result.PaymentId) || !paymentUrl(result.PaymentURL) || typeof result.Status!=='string' || !Object.hasOwn(BANK_RANK,result.Status))
      throw new PaymentError(502,'Ответ банка требует проверки.',{code:'BANK_RESPONSE_INVALID',stage:'init',retryable:false});
  } catch(cause) {
    const state = definitive ? 'INIT_FAILED' : 'INIT_OUTCOME_UNKNOWN';
    const changed = database().prepare(`UPDATE payment_orders SET status=?,active_document=CASE WHEN ? THEN NULL ELSE active_document END,
      updated_at=? WHERE id=? AND status='INITIALIZING' AND status_rank=0 AND payment_id IS NULL`).bind(state,definitive?1:0,Date.now(),id).run().meta.changes;
    if (changed) diagnostic('payment.status_changed',{previousStatus:'INITIALIZING',status:state});
    diagnostic(definitive ? 'payment.init_failed' : 'payment.init_outcome_unknown',
      {errorCode:normalizeError(cause).code,durationMs:Math.round(performance.now()-started),retryable:false}, 'warn');
    if (definitive && changed) throw cause;
    throw checkRequired(502,cause);
  }
  await applyBankState(result);
  const linked=database().prepare(`UPDATE payment_orders SET payment_url=? WHERE id=? AND payment_id=?
    AND active_document IS NOT NULL AND cancel_requested_at=0 AND status_rank<20`)
    .bind(paymentUrl(result.PaymentURL),id,bankId(result.PaymentId)).run().meta.changes;
  diagnostic('payment.init_succeeded',{durationMs:Math.round(performance.now()-started)});
  const current=await ownedDocument(documentId,owner);
  if (hasAccess(current.billingState)) return {document:presentContract(current),paymentUrl:null};
  if (!linked) throw checkRequired(409);
  return {document:presentContract(current),paymentUrl:paymentUrl(result.PaymentURL)};
}
export async function paymentStatus(documentId:string,owner:string){
  const deadline = performance.now()+SITE_MS;
  const row=await ownedDocument(documentId,owner);
  const order=await latestOrder(documentId,owner);
  if(!order)return {document:presentContract(row),status:'NOT_STARTED'};
  return withPaymentOrder(order.id,async()=>{
    if(order.status!=='INIT_FAILED')await checkOrder(order,deadline);
    const current=await ownedDocument(documentId,owner),updated=await orderById(order.id);
    return {document:await presentPaymentDocument(current,owner),status:updated?.status||'NOT_STARTED'};
  });
}
