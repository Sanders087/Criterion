import { CONTRACT_PRICE } from './billing.ts';

export type TBankEnv = {
  TBANK_ENABLED?:string; TBANK_TERMINAL_KEY?:string; TBANK_PASSWORD?:string;
  TBANK_PUBLIC_URL?:string; TBANK_API_URL?:string; TBANK_RECEIPT_MODE?:string;
  TBANK_TAXATION?:string; TBANK_TAX?:string; TBANK_PAYMENT_METHOD?:string; TBANK_PAYMENT_OBJECT?:string;
  TBANK_GATEWAY_URL?:string; TBANK_GATEWAY_SECRET?:string; TBANK_MODE?:string;
  TBANK_NOTIFICATION_URL?:string;
};
export class PaymentError extends Error {
  status:number;
  constructor(status:number,message:string){super(message);this.status=status}
}
export type BankData = Record<string,unknown>;
const API_URLS=['https://securepay.tinkoff.ru/v2/','https://rest-api-test.tinkoff.ru/v2/'];
const PAYMENT_HOSTS=['securepay.tinkoff.ru','rest-api-test.tinkoff.ru','pay.tbank-online.com'];
const taxation=['osn','usn_income','usn_income_outcome','esn','patent'];
const taxes=['none','vat0','vat5','vat7','vat10','vat22','vat105','vat107','vat110','vat122'];
export function bankConfig(env:TBankEnv){
  const terminalKey=env.TBANK_TERMINAL_KEY?.trim(),password=env.TBANK_PASSWORD;
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
    }catch{throw new PaymentError(503,'Оплата пока недоступна. Соединение с банком ещё не настроено.')}
  }
  return {terminalKey,password,apiUrl,gatewayUrl};
}
export function checkoutConfig(env:TBankEnv){
  const config=bankConfig(env);
  let origin:URL;try{origin=new URL(env.TBANK_PUBLIC_URL||'')}catch{throw new PaymentError(503,'Оплата пока недоступна. Адрес магазина не настроен.')}
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
export async function bankRequest(env:TBankEnv,method:'Init'|'GetState'|'CheckOrder'|'Cancel',params:BankData):Promise<BankData>{
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
    headers['X-Criterion-Signature']=Array.from(new Uint8Array(signed),b=>b.toString(16).padStart(2,'0')).join('');
  }
  let response:Response;
  try{response=await fetch(url,{method:'POST',headers,body,signal:AbortSignal.timeout(15000),redirect:'manual'})}
  catch{throw new PaymentError(502,'Банк пока не ответил. Проверьте статус оплаты перед повторной попыткой.')}
  if(!response.ok){
    // Record only transport metadata; never log signed requests or payment data.
    console.error('TBank upstream request failed',{method,httpStatus:response.status,server:response.headers.get('server'),contentType:response.headers.get('content-type')});
    throw new PaymentError(502,'Банк временно недоступен. Проверьте статус оплаты позже.');
  }
  let data:BankData;try{data=await response.json() as BankData}catch{throw new PaymentError(502,'Не удалось прочитать ответ банка. Проверьте статус оплаты позже.')}
  if(!data||typeof data!=='object'||Array.isArray(data))throw new PaymentError(502,'Не удалось прочитать ответ банка.');
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
