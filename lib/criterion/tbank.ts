import { Buffer } from 'node:buffer';
import { AppError } from './app-error.ts';
import { diagnostic } from '../diagnostics.mjs';
import { getRequestContext } from '../request-context.mjs';
import { SITE_MS, networkCode, retryableRead, traceInput, isBankCode, validBankEnvelope } from '../payment-network.mjs';
import { CONTRACT_PRICE } from './billing.ts';

export type TBankEnv = {
  TBANK_ENABLED?:string; TBANK_TERMINAL_KEY?:string; TBANK_PASSWORD?:string; TBANK_PASSWORD_BASE64?:string;
  TBANK_PUBLIC_URL?:string; TBANK_API_URL?:string; TBANK_RECEIPT_MODE?:string;
  TBANK_TAXATION?:string; TBANK_TAX?:string; TBANK_PAYMENT_METHOD?:string; TBANK_PAYMENT_OBJECT?:string;
  TBANK_GATEWAY_URL?:string; TBANK_GATEWAY_SECRET?:string; TBANK_MODE?:string;
  TBANK_NOTIFICATION_URL?:string;
};
type PaymentDetails = { code?:string; stage?:string; cause?:unknown; retryable?:boolean; upstreamStatus?:number };
export class PaymentError extends AppError {
  constructor(status:number, message:string, details:PaymentDetails = {}) {
    const code = details.code ?? (status === 503 ? 'PAYMENT_UNAVAILABLE' : 'PAYMENT_ERROR');
    super({ ...details, status, code, publicMessage:message, service:'payments', stage:details.stage ?? 'payment' });
  }
}
export type BankData = Record<string,unknown>;
const API_URLS=['https://securepay.tinkoff.ru/v2/','https://rest-api-test.tinkoff.ru/v2/'];
const PAYMENT_HOSTS=['securepay.tinkoff.ru','rest-api-test.tinkoff.ru','pay.tbank-online.com'];
const taxation=['osn','usn_income','usn_income_outcome','esn','patent'];
const taxes=['none','vat0','vat5','vat7','vat10','vat22','vat105','vat107','vat110','vat122'];
function bankPassword(env:TBankEnv){
  const encoded=env.TBANK_PASSWORD_BASE64;
  if(!encoded)return env.TBANK_PASSWORD;
  try{
    // Reject ambiguous settings and malformed Base64 instead of changing the secret silently.
    if(env.TBANK_PASSWORD||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw new Error();
    const bytes=Buffer.from(encoded,'base64');
    if(bytes.toString('base64')!==encoded)throw new Error();
    // Preserve every character, including leading/trailing whitespace and a UTF-8 BOM.
    return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  }catch(cause){throw new PaymentError(503,'Оплата пока недоступна. Настройки банка ещё не завершены.',{cause})}
}
export function bankConfig(env:TBankEnv){
  const terminalKey=env.TBANK_TERMINAL_KEY?.trim(),password=bankPassword(env);
  const apiUrl=env.TBANK_API_URL||API_URLS[0];
  if(!terminalKey||!password||!API_URLS.includes(apiUrl))throw new PaymentError(503,'Оплата пока недоступна. Настройки банка ещё не завершены.');
  if(env.TBANK_MODE==='live'&&!/^\d{5,24}$/.test(terminalKey))throw new PaymentError(503,'Боевой терминал банка ещё не настроен.');
  let gatewayUrl:string|undefined;
  if(env.TBANK_GATEWAY_URL||env.TBANK_GATEWAY_SECRET){
    try{
      const url=new URL(env.TBANK_GATEWAY_URL||'');
      const demo=terminalKey.endsWith('DEMO')&&env.TBANK_MODE!=='live'&&url.pathname==='/criterion-tbank/';
      const live=env.TBANK_MODE==='live'&&/^\d{5,24}$/.test(terminalKey)&&url.pathname==='/criterion-tbank-live/';
      if(url.origin!=='https://srv678677.hstgr.cloud'||(!demo&&!live)||url.username||url.password||url.search||url.hash||!env.TBANK_GATEWAY_SECRET?.match(/^[a-f0-9]{64}$/)||apiUrl!==API_URLS[0])throw new Error('Invalid gateway');
      gatewayUrl=url.href;
    }catch(cause){throw new PaymentError(503,'Оплата пока недоступна. Соединение с банком ещё не настроено.',{cause})}
  }
  return {terminalKey,password,apiUrl,gatewayUrl};
}
export function checkoutConfig(env:TBankEnv){
  const config=bankConfig(env);
  let origin:URL;try{origin=new URL(env.TBANK_PUBLIC_URL||'')}catch(cause){throw new PaymentError(503,'Оплата пока недоступна. Адрес магазина не настроен.',{cause})}
  if(env.TBANK_ENABLED!=='true'||origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new PaymentError(503,'Оплата пока недоступна. Подключение магазина ещё не завершено.');
  if(!['bank','external'].includes(env.TBANK_RECEIPT_MODE||''))throw new PaymentError(503,'Оплата пока недоступна. Формирование чеков ещё не настроено.');
  if(env.TBANK_RECEIPT_MODE==='bank'&&(!taxation.includes(env.TBANK_TAXATION||'')||!taxes.includes(env.TBANK_TAX||'')||!['full_payment','full_prepayment'].includes(env.TBANK_PAYMENT_METHOD||'')||!['service','intellectual_activity','property_rights'].includes(env.TBANK_PAYMENT_OBJECT||'')))throw new PaymentError(503,'Оплата пока недоступна. Параметры чека ещё не настроены.');
  const notificationUrl=env.TBANK_NOTIFICATION_URL||origin.origin+'/api/payments/tbank/notification';
  if(env.TBANK_NOTIFICATION_URL&&(config.gatewayUrl!=='https://srv678677.hstgr.cloud/criterion-tbank-live/'||env.TBANK_MODE!=='live'||notificationUrl!==config.gatewayUrl+'notification'))throw new PaymentError(503,'Подтверждение оплаты ещё не настроено.');
  return {...config,origin:origin.origin,notificationUrl};
}
export function checkoutReady(env:TBankEnv){try{checkoutConfig(env);return true}catch{return false}}
export async function bankToken(data:BankData,password:string){
  // Only scalar root fields participate. Never accept a caller-supplied Password.
  const fields:BankData={...data,Password:password};
  const value=Object.keys(fields).filter(k=>k!=='Token'&&fields[k]!==null&&fields[k]!==undefined&&['string','number','boolean'].includes(typeof fields[k])).sort().map(k=>String(fields[k])).join('');
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function verifyBankToken(data:BankData,password:string){
  if(typeof data.Token!=='string'||!/^[a-f0-9]{64}$/i.test(data.Token))return false;
  const expected=await bankToken(data,password),actual=data.Token.toLowerCase();let diff=0;
  for(let i=0;i<64;i++)diff|=actual.charCodeAt(i)^expected.charCodeAt(i);return diff===0;
}
export function paymentUrl(value:unknown){
  if(typeof value!=='string')return null;
  try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&PAYMENT_HOSTS.includes(url.hostname)?url.href:null}catch{return null}
}
export async function bankRequest(env:TBankEnv,method:'Init'|'GetState'|'CheckOrder'|'Cancel',params:BankData, deadline = performance.now()+SITE_MS):Promise<BankData>{
  const config=bankConfig(env);const payload={...params,TerminalKey:config.terminalKey};
  const body=JSON.stringify({...payload,Token:await bankToken(payload,config.password)});
  const headers:Record<string,string>={'Content-Type':'application/json'};
  let url=config.apiUrl+method;
  if(config.gatewayUrl){
    url=config.gatewayUrl+'bank/'+method;
    const timestamp=String(Math.floor(Date.now()/1000)),nonce=crypto.randomUUID();
    const bytes=Uint8Array.from(env.TBANK_GATEWAY_SECRET!.match(/../g)!,hex=>parseInt(hex,16));
    const key=await crypto.subtle.importKey('raw',bytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const signed=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${timestamp}\n${nonce}\n${method}\n${body}`));
    headers['X-Criterion-Timestamp']=timestamp;headers['X-Criterion-Nonce']=nonce;
    headers['X-Criterion-Signature']=Buffer.from(signed).toString('hex');
    const { requestId, operationId } = getRequestContext() ?? {};
    if (requestId && operationId) {
      headers['X-Request-ID'] = requestId;
      headers['X-Operation-ID'] = operationId;
      const trace = traceInput(headers['X-Criterion-Signature'], requestId, operationId);
      headers['X-Criterion-Trace-Signature'] = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(trace))).toString('hex');
    }
  }
  const gateway = Boolean(config.gatewayUrl);
  const fields = {component:'payment_site', stage:gateway ? 'gateway_request' : 'bank_request', bankMethod:method};
  const started = performance.now();
  const fail = (code:string,cause?:unknown,status?:number) => {
    // On forwarded failures, the HTTP status belongs to the gateway rather than the bank.
    const retryable = retryableRead(method,code,gateway && code.startsWith('BANK_') ? undefined : status);
    const stage = code.endsWith('_NETWORK_ERROR') ? 'unknown' : fields.stage;
    diagnostic('payment.transport_failed', {...fields,stage,errorCode:code,upstreamStatus:status,retryable,durationMs:Math.round(performance.now()-started)},'error');
    return new PaymentError(502,'Не удалось получить подтверждение банка. Проверьте статус оплаты перед повторной попыткой.', {code,stage,cause,retryable,upstreamStatus:status});
  };
  diagnostic('payment.transport_started', fields);
  const remaining = Math.min(SITE_MS, Math.ceil(deadline - performance.now()));
  if (remaining <= 0) throw fail(gateway ? 'GATEWAY_TIMEOUT' : 'BANK_TIMEOUT');
  let response:Response;
  try {
    response = await fetch(url,{method:'POST',headers,body,signal:AbortSignal.timeout(remaining),redirect:'manual'});
  } catch(cause) { throw fail(networkCode(cause,gateway),cause); }
  const status = response.status;
  if (!response.ok) {
    const bankCode = response.headers.get('x-criterion-bank-error');
    await response.body?.cancel().catch(() => {});
    throw fail(gateway && bankCode && isBankCode(bankCode) ? bankCode : gateway ? 'GATEWAY_HTTP_ERROR' : 'BANK_HTTP_ERROR',undefined,status);
  }
  const invalid = gateway ? 'GATEWAY_RESPONSE_INVALID' : 'BANK_RESPONSE_INVALID';
  let data:BankData;
  try { data = await response.json() as BankData; }
  catch(cause) { throw fail(cause instanceof SyntaxError ? invalid : networkCode(cause,gateway,true),cause,status); }
  if (!validBankEnvelope(data)) throw fail(invalid,undefined,status);
  const rejected = data.Success === false;
  diagnostic(rejected ? 'payment.transport_failed' : 'payment.transport_completed',
    {...fields,upstreamStatus:status,durationMs:Math.round(performance.now()-started),
     ...(rejected ? {errorCode:'BANK_REQUEST_REJECTED',retryable:false} : {})},rejected ? 'warn' : 'info');
  // The caller reconciles documented bank refusals (including CheckOrder 335).
  return data;
}
export function initParameters(env:TBankEnv,orderId:string,documentId:string,email:string):BankData {
  const {origin,notificationUrl}=checkoutConfig(env);const query='?document='+encodeURIComponent(documentId);
  const result:BankData={Amount:CONTRACT_PRICE,OrderId:orderId,Description:'Создание договора на основе системы Критерион',PayType:'O',Language:'ru',
    SuccessURL:origin+'/'+query+'&payment=success',FailURL:origin+'/'+query+'&payment=fail',
    NotificationURL:notificationUrl,DATA:{OperationInitiatorType:'0'}};
  if(env.TBANK_RECEIPT_MODE==='bank'){
    if(email.length>64||!/^\S+@[^\s@]+\.[^\s@]+$/.test(email))throw new PaymentError(400,'Укажите email для чека длиной не более 64 символов.');
    if(env.TBANK_MODE==='live'&&/@(?:[^@]+\.)?(?:example\.(?:com|net|org)|invalid|test|localhost)$/i.test(email))throw new PaymentError(400,'Укажите действующий email для чека.');
    result.Receipt={Email:email,Taxation:env.TBANK_TAXATION,Items:[{Name:'Создание договора на основе системы Критерион',Price:CONTRACT_PRICE,Quantity:1,Amount:CONTRACT_PRICE,Tax:env.TBANK_TAX,PaymentMethod:env.TBANK_PAYMENT_METHOD,PaymentObject:env.TBANK_PAYMENT_OBJECT}]};
  }
  return result;
}
export const BANK_RANK:Record<string,number>={NEW:1,FORM_SHOWED:2,PREAUTHORIZING:3,AUTHORIZING:4,'3DS_CHECKING':5,'3DS_CHECKED':6,AUTHORIZED:10,CONFIRMING:11,CONFIRMED:20,AUTH_FAIL:7,REJECTED:25,CANCELED:25,DEADLINE_EXPIRED:25,REVERSED:25,PARTIAL_REFUNDED:30,REFUNDED:40};
export const FAILED_BANK_STATUSES=['REJECTED','CANCELED','DEADLINE_EXPIRED','REVERSED'];
export function successfulBankResponse(data:BankData){return data.Success===true&&String(data.ErrorCode)==='0'}
export function bankId(value:unknown){return (typeof value==='string'&&/^\d{1,20}$/.test(value))||(typeof value==='number'&&Number.isSafeInteger(value)&&value>0)?String(value):null}
export function bankAmount(value:unknown){const number=typeof value==='string'&&/^\d{1,15}$/.test(value)?Number(value):value;return typeof number==='number'&&Number.isSafeInteger(number)&&number>=0?number:null}
