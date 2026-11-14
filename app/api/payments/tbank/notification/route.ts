import {runtime,failure,HttpError} from '../../../../../lib/criterion/server';
import {bankConfig,verifyBankToken,type BankData} from '../../../../../lib/criterion/tbank';
import {applyBankState} from '../../../../../lib/criterion/payments';
export async function POST(request:Request){try{
  // Bank-to-server notifications have no user cookie or browser Origin.
  if(!request.headers.get('content-type')?.includes('application/json'))throw new HttpError(415,'Ожидается JSON.');
  if(Number(request.headers.get('content-length')||0)>16000)throw new HttpError(413,'Слишком большой запрос.');
  const raw=await request.text();if(raw.length>16000)throw new HttpError(413,'Слишком большой запрос.');
  let data:BankData;try{data=JSON.parse(raw)}catch{throw new HttpError(400,'Неверный JSON.')}
  if(!data||typeof data!=='object'||Array.isArray(data))throw new HttpError(400,'Неверное уведомление.');
  const config=bankConfig(runtime());
  if(data.TerminalKey!==config.terminalKey||!await verifyBankToken(data,config.password))throw new HttpError(403,'Неверная подпись.');
  await applyBankState(data);
  return new Response('OK',{status:200,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
}catch(e){return failure(e)}}
