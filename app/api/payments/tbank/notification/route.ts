import {diagnostic} from '../../../../../lib/diagnostics.mjs';
import {runtime,apiDefaults, apiRoute,HttpError} from '../../../../../lib/criterion/server';
import {bankConfig,verifyBankToken,type BankData} from '../../../../../lib/criterion/tbank';
import {applyBankState} from '../../../../../lib/criterion/payments';
function reject(status:number, message:string, reason:string, cause?:unknown):never {
  diagnostic('payment.notification_rejected',{reason},'warn');
  throw new HttpError(status,message,cause);
}
export const POST = apiRoute('/api/payments/tbank/notification', async (request:Request) => {
  // Bank-to-server notifications have no user cookie or browser Origin.
  if(!request.headers.get('content-type')?.includes('application/json'))reject(415,'Ожидается JSON.','invalid_format');
  if(Number(request.headers.get('content-length')||0)>16000)reject(413,'Слишком большой запрос.','invalid_format');
  const raw=await request.text();if(raw.length>16000)reject(413,'Слишком большой запрос.','invalid_format');
  let data:BankData;try{data=JSON.parse(raw)}catch(cause){reject(400,'Неверный JSON.','invalid_format',cause)}
  if(!data||typeof data!=='object'||Array.isArray(data))reject(400,'Неверное уведомление.','invalid_format');
  const config=bankConfig(runtime());
  if(data.TerminalKey!==config.terminalKey)reject(403,'Неверная подпись.','unknown_terminal');
  if(!await verifyBankToken(data,config.password))reject(403,'Неверная подпись.','invalid_signature');
  await applyBankState(data,'notification');
  return new Response('OK',{status:200,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
});

export const { GET, HEAD, PUT, PATCH, DELETE, OPTIONS } = apiDefaults('/api/payments/tbank/notification', ['POST']);
