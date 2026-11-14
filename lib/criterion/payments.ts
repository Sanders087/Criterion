import {env} from 'cloudflare:workers';
import {and,eq} from 'drizzle-orm';
import {getDb} from '../../db';
import {documents} from '../../db/schema';
import {CONTRACT_PRICE,hasAccess,presentContract} from './billing';
import {runtime,HttpError} from './server';
import {digest} from './auth';
import {bankConfig,checkoutConfig,bankRequest,initParameters,paymentUrl,PaymentError,bankId,bankAmount,BANK_RANK,FAILED_BANK_STATUSES,successfulBankResponse,type BankData} from './tbank';

type Order={id:string;document_id:string;owner:string;active_document:string|null;amount:number;terminal_key:string;payment_id:string|null;payment_url:string|null;status:string;status_rank:number;created_at:number;checked_at:number};
const database=()=>env.DB!;
export async function ownedDocument(id:string,owner:string){
  const [row]=await getDb().select().from(documents).where(and(eq(documents.id,id),eq(documents.owner,owner)));
  if(!row)throw new HttpError(404,'Документ не найден.');return row;
}
async function latestOrder(id:string,owner:string){return database().prepare('SELECT * FROM payment_orders WHERE document_id=? AND owner=? ORDER BY created_at DESC LIMIT 1').bind(id,owner).first<Order>()}
async function orderById(id:string){return database().prepare('SELECT * FROM payment_orders WHERE id=?').bind(id).first<Order>()}

/** Called only after token verification or a direct authenticated bank API response. */
export async function applyBankState(data:BankData){
  const paymentId=bankId(data.PaymentId),orderId=data.OrderId,status=data.Status,amount=bankAmount(data.Amount);
  if(typeof orderId!=='string'||typeof status!=='string'||!paymentId||amount===null)throw new PaymentError(400,'Неверный формат уведомления об оплате.');
  const order=await orderById(orderId);if(!order)throw new PaymentError(404,'Заказ не найден.');
  if(data.TerminalKey!==order.terminal_key||data.TerminalKey!==bankConfig(runtime()).terminalKey||(order.payment_id&&order.payment_id!==paymentId))throw new PaymentError(400,'Платёж не соответствует заказу.');
  const refund=status==='REFUNDED'||status==='PARTIAL_REFUNDED',cancelled=FAILED_BANK_STATUSES.includes(status);
  if(((refund||cancelled)&&(amount<0||amount>order.amount))||(!refund&&!cancelled&&amount!==order.amount))throw new PaymentError(400,'Сумма платежа не соответствует заказу.');
  if(['CONFIRMED','PARTIAL_REFUNDED','REFUNDED'].includes(status)&&!successfulBankResponse(data))throw new PaymentError(400,'Банк не подтвердил операцию.');
  const rank=BANK_RANK[status];if(rank===undefined)return;
  const now=Date.now(),failed=FAILED_BANK_STATUSES.includes(status);
  // The batch is atomic. A delayed AUTHORIZED/CONFIRMED cannot undo a refund.
  // Rights are derived from the persisted state, not from the incoming notification.
  await database().batch([
    database().prepare('UPDATE payment_orders SET payment_id=COALESCE(payment_id,?),status=?,status_rank=?,updated_at=?,active_document=CASE WHEN ? THEN NULL ELSE active_document END WHERE id=? AND status_rank<=? AND (payment_id IS NULL OR payment_id=?)')
      .bind(paymentId,status,rank,now,failed?1:0,order.id,rank,paymentId),
    database().prepare('INSERT OR IGNORE INTO payment_events (id,order_id,status,amount,created_at) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(),order.id,status,amount,now),
    database().prepare("UPDATE documents SET billing_state='paid' WHERE id=? AND owner=? AND billing_state='unpaid' AND EXISTS (SELECT 1 FROM payment_orders WHERE id=? AND status IN ('CONFIRMED','PARTIAL_REFUNDED'))")
      .bind(order.document_id,order.owner,order.id),
    database().prepare("UPDATE documents SET billing_state='refunded' WHERE id=? AND owner=? AND billing_state IN ('unpaid','paid') AND EXISTS (SELECT 1 FROM payment_orders WHERE id=? AND status='REFUNDED')")
      .bind(order.document_id,order.owner,order.id),
  ]);
}

async function reconcile(order:Order){
  if(order.terminal_key!==bankConfig(runtime()).terminalKey)throw new PaymentError(503,'Проверка этого платежа временно недоступна. Обратитесь в поддержку.');
  const now=Date.now();
  if(order.status==='INITIALIZING'&&order.created_at>now-30000)return;
  const claim=await database().prepare('UPDATE payment_orders SET checked_at=? WHERE id=? AND checked_at<?').bind(now,order.id,now-5000).run();
  if(claim.meta.changes!==1)return;
  let paymentId=order.payment_id;
  if(!paymentId){
    // Recover an Init whose HTTP response was lost; never blindly create a second payment.
    const result=await bankRequest(runtime(),'CheckOrder',{OrderId:order.id});
    // Bank error 335 explicitly means this OrderId does not exist on this terminal.
    // Wait beyond the request timeout and release only a never-initialized order.
    // Unknown errors, existing payment IDs and concurrent notifications stay closed.
    if(result.Success===false&&String(result.ErrorCode)==='335'&&order.created_at<now-120000&&!order.payment_url){
      await database().prepare("UPDATE payment_orders SET status='INIT_FAILED',active_document=NULL,updated_at=? WHERE id=? AND status='INITIALIZING' AND status_rank=0 AND payment_id IS NULL AND payment_url IS NULL")
        .bind(now,order.id).run();
      return;
    }
    if(!successfulBankResponse(result)||result.OrderId!==order.id||result.TerminalKey!==order.terminal_key||!Array.isArray(result.Payments))return;
    if(result.Payments.length!==1)return;
    paymentId=bankId((result.Payments[0] as BankData).PaymentId);
    if(!paymentId)return;
  }
  const result=await bankRequest(runtime(),'GetState',{PaymentId:paymentId});
  if(!successfulBankResponse(result))throw new PaymentError(502,'Не удалось проверить оплату в банке. Повторите проверку позже.');
  // Validate the exact ID requested as well as the immutable order/amount.
  if(result.OrderId!==order.id||bankId(result.PaymentId)!==paymentId)throw new PaymentError(502,'Ответ банка не соответствует платежу.');
  await applyBankState(result);
  // If Init's response was lost, the customer never received a payment link.
  // Only an untouched NEW payment may be cancelled automatically. A new order
  // is allowed only after GetState confirms that the old payment is closed.
  const current=await orderById(order.id);
  if(current&&!current.payment_url&&current.status==='NEW'&&current.created_at<now-30000){
    const cancelled=await bankRequest(runtime(),'Cancel',{PaymentId:paymentId});
    if(!successfulBankResponse(cancelled))return;
    const finalState=await bankRequest(runtime(),'GetState',{PaymentId:paymentId});
    if(!successfulBankResponse(finalState)||finalState.OrderId!==order.id||bankId(finalState.PaymentId)!==paymentId)throw new PaymentError(502,'Статус платежа пока уточняется.');
    await applyBankState(finalState);
  }
}

export async function checkout(documentId:string,owner:string,email:string){
  const row=await ownedDocument(documentId,owner);
  if(hasAccess(row.billingState))return {document:presentContract(row),paymentUrl:null};
  if(row.billingState==='refunded')throw new PaymentError(409,'Оплата этого договора возвращена. Обратитесь в поддержку.');
  if(!JSON.parse(row.body).sections?.length)throw new PaymentError(409,'Сначала завершите интервью и создайте черновик.');
  if(row.lockUntil&&row.lockUntil>Date.now())throw new PaymentError(409,'Дождитесь завершения текущего действия.');
  const config=checkoutConfig(runtime());
  let order=await database().prepare('SELECT * FROM payment_orders WHERE active_document=? AND owner=?').bind(documentId,owner).first<Order>();
  if(order){
    await reconcile(order);order=(await orderById(order.id))!;
    const current=await ownedDocument(documentId,owner);
    if(hasAccess(current.billingState))return {document:presentContract(current),paymentUrl:null};
    if(order.active_document){
      if(order.status==='REFUNDED')throw new PaymentError(409,'Оплата возвращена. Обратитесь в поддержку.');
      const url=paymentUrl(order.payment_url);
      if(!url)throw new PaymentError(409,'Статус платежа уточняется. Нажмите «Проверить оплату». Повторный платёж пока не создаётся.');
      return {document:presentContract(current),paymentUrl:url};
    }
  }
  const id=crypto.randomUUID(),now=Date.now();
  // Prepare parameters before reserving the order, so bad receipt config cannot strand it.
  const params=initParameters(runtime(),id,documentId,email);
  const limitKey=await digest('payment-init:'+owner);
  const attempts=await database().prepare('INSERT INTO auth_limits (key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count').bind(limitKey,now+600000,now,now).first<{count:number}>();
  if((attempts?.count||0)>10)throw new PaymentError(429,'Слишком много попыток оплаты. Повторите через 10 минут.');
  const created=await database().prepare("INSERT OR IGNORE INTO payment_orders (id,document_id,owner,active_document,amount,terminal_key,status,status_rank,created_at,updated_at,checked_at) SELECT ?,id,owner,id,?,?,'INITIALIZING',0,?,?,0 FROM documents WHERE id=? AND owner=? AND billing_state='unpaid' AND (lock_until IS NULL OR lock_until<?)")
    .bind(id,CONTRACT_PRICE,config.terminalKey,now,now,documentId,owner,now).run();
  if(created.meta.changes!==1)throw new PaymentError(409,'Платёж уже создаётся. Нажмите «Проверить оплату».');
  const result=await bankRequest(runtime(),'Init',params);
  if(!successfulBankResponse(result)){
    await database().prepare("UPDATE payment_orders SET status='INIT_FAILED',active_document=NULL,updated_at=? WHERE id=? AND payment_id IS NULL AND status_rank=0").bind(Date.now(),id).run();
    throw new PaymentError(502,'Банк не создал платёж. Попробуйте позже или обратитесь в поддержку.');
  }
  if(result.OrderId!==id||result.TerminalKey!==config.terminalKey||bankAmount(result.Amount)!==CONTRACT_PRICE||!bankId(result.PaymentId)||!paymentUrl(result.PaymentURL))throw new PaymentError(502,'Ответ банка требует проверки. Нажмите «Проверить оплату».');
  await applyBankState(result);
  await database().prepare('UPDATE payment_orders SET payment_url=? WHERE id=? AND payment_id=?').bind(paymentUrl(result.PaymentURL),id,bankId(result.PaymentId)).run();
  const current=await ownedDocument(documentId,owner);
  return {document:presentContract(current),paymentUrl:hasAccess(current.billingState)?null:paymentUrl(result.PaymentURL)};
}
export async function paymentStatus(documentId:string,owner:string){
  await ownedDocument(documentId,owner);
  const order=await latestOrder(documentId,owner);
  if(order&&order.status!=='INIT_FAILED')await reconcile(order);
  const current=await ownedDocument(documentId,owner),updated=order?await orderById(order.id):null;
  return {document:presentContract(current),status:updated?.status||'NOT_STARTED'};
}
