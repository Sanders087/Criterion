import {observeOperation, reportSuppressed} from './api-observability';
import {AppError, normalizeError} from './app-error';
import {env} from '../runtime';
import {digest,randomToken} from './auth';
import {sendAuthMail,type MailConfig,mailReady} from './mail';
export const mailConfig=()=>env as MailConfig;
export function issueEmail(accountId:string,purpose:'verify'|'reset'){
 return observeOperation('mail','mail_delivery',async () => {
  try { await deliverEmail(accountId,purpose); }
  catch (cause) {
   if (cause instanceof AppError && cause.status === 503) throw cause;
   const reason = normalizeError(cause);
   throw new AppError({status:503,code:'MAIL_SEND_FAILED',publicMessage:'Не удалось отправить письмо. Повторите позже.',
    service:reason.service,stage:reason.stage,cause,retryable:false});
  }
 });
}
async function deliverEmail(accountId:string,purpose:'verify'|'reset'){
 const config=mailConfig();if(!mailReady(config))throw new AppError({status:503,code:'MAIL_SEND_FAILED',publicMessage:'Не удалось отправить письмо. Повторите позже.',service:'mail',stage:'configuration'});
 const account=await env.DB!.prepare('SELECT email,password_hash FROM accounts WHERE id=?').bind(accountId).first<{email:string,password_hash:string}>();if(!account)throw new Error('ACCOUNT_NOT_FOUND');
 const token=randomToken(),hash=await digest(token),now=Date.now();
 await env.DB!.batch([env.DB!.prepare('DELETE FROM email_tokens WHERE expires_at<=?').bind(now),env.DB!.prepare('INSERT INTO email_tokens (token_hash,account_id,email,purpose,credential_hash,expires_at) VALUES (?,?,?,?,?,?)').bind(hash,accountId,account.email,purpose,account.password_hash,now+(purpose==='verify'?86400000:1800000))]);
 try{await sendAuthMail(config,account.email,purpose,token,'criterion-'+hash)}catch(cause){
  try { await env.DB!.prepare('DELETE FROM email_tokens WHERE token_hash=?').bind(hash).run(); }
  catch (cleanupCause) { reportSuppressed(new AppError({ status:500, code:'CLEANUP_FAILED',
    publicMessage:'Не удалось очистить запись письма.',service:'database',stage:'cleanup',cause:cleanupCause })); }
  throw cause;
 }
}
