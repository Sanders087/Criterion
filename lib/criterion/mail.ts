import { AppError } from './app-error.ts';
import {z} from 'zod';
export type MailConfig = {RESEND_API_KEY?:string;EMAIL_FROM?:string;EMAIL_REPLY_TO?:string;AUTH_PUBLIC_URL?:string};
const replyToSchema=z.string().email().max(254);
export function mailReady(config:MailConfig){
 if(!config.RESEND_API_KEY?.trim()||!config.EMAIL_FROM?.trim()||!config.AUTH_PUBLIC_URL)return false;
 const replyTo=config.EMAIL_REPLY_TO?.trim();
 if(config.EMAIL_REPLY_TO&&(/[\r\n]/.test(config.EMAIL_REPLY_TO)||(replyTo&&!replyToSchema.safeParse(replyTo).success)))return false;
 try {const u=new URL(config.AUTH_PUBLIC_URL);return u.protocol==='https:'&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash} catch{return false}
}
export function authMessage(purpose:'verify'|'reset',origin:string,token:string,email:string){
 const link=new URL('/auth',origin);link.hash=new URLSearchParams({action:purpose,token}).toString();
 const title=purpose==='verify'?'Подтвердите email аккаунта Criterion':'Сброс пароля аккаунта Criterion';
 const context=purpose==='verify'?`Вы начали регистрацию аккаунта Criterion для ${email}.`:`Для вашего аккаунта Criterion (${email}) запрошен сброс пароля.`;
 const instruction=purpose==='verify'?'Подтвердите адрес в том браузере, где вы вошли в Criterion.':'Откройте ссылку и задайте новый пароль. После смены пароля прежние сеансы будут завершены.';
 const ttl=purpose==='verify'?'24 часа':'30 минут';
 const ifIgnored=purpose==='verify'?'Если вы не регистрировались в Criterion, просто проигнорируйте это письмо.':'Если вы не запрашивали сброс, просто проигнорируйте письмо — ваш пароль останется прежним.';
 return {subject:title,text:`${context}\n\n${instruction}\n\n${link.href}\n\nСсылка действует ${ttl} и используется один раз. ${ifIgnored} Никому не пересылайте ссылку.\n\nCriterion`};
}
type DeliveryCode = 'MAIL_CONFIG_INVALID' | 'MAIL_PROVIDER_REJECTED' | 'MAIL_OUTCOME_UNKNOWN';
function deliveryError(code: DeliveryCode, stage: 'configuration' | 'provider_request' | 'provider_response', cause?: unknown, upstreamStatus?: number) {
 return new AppError({status:503, code, publicMessage:'Не удалось подтвердить отправку письма. Попробуйте позже.',
  service:'mail', stage, cause, upstreamStatus, retryable:false});
}
export async function sendAuthMail(config:MailConfig,to:string,purpose:'verify'|'reset',token:string,idempotencyKey:string,transport:typeof fetch=fetch){
 if(!mailReady(config))throw deliveryError('MAIL_CONFIG_INVALID','configuration');
 const message=authMessage(purpose,config.AUTH_PUBLIC_URL!,token,to),replyTo=config.EMAIL_REPLY_TO?.trim();
 let response: Response;
 try { response=await transport('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${config.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':idempotencyKey},body:JSON.stringify({from:config.EMAIL_FROM,to:[to],...(replyTo?{reply_to:replyTo}:{}),...message}),signal:AbortSignal.timeout(12000)});
 } catch(cause) { throw deliveryError('MAIL_OUTCOME_UNKNOWN','provider_request',cause); }
 if(!response.ok){
  await response.body?.cancel().catch(() => {});
  throw deliveryError(response.status >= 400 && response.status < 500 && ![408,409].includes(response.status) ? 'MAIL_PROVIDER_REJECTED' : 'MAIL_OUTCOME_UNKNOWN','provider_response',undefined,response.status);
 }
 let result: {id?:string};
 try { result=await response.json(); } catch(cause) { throw deliveryError('MAIL_OUTCOME_UNKNOWN','provider_response',cause,response.status); }
 if(typeof result?.id !== 'string' || result.id.length !== 36 || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(result.id))throw deliveryError('MAIL_OUTCOME_UNKNOWN','provider_response',undefined,response.status);
 return result.id;
}
