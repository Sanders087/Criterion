export type MailConfig = {RESEND_API_KEY?:string;EMAIL_FROM?:string;AUTH_PUBLIC_URL?:string};
export function mailReady(config:MailConfig){
 if(!config.RESEND_API_KEY?.trim()||!config.EMAIL_FROM?.trim()||!config.AUTH_PUBLIC_URL)return false;
 try {const u=new URL(config.AUTH_PUBLIC_URL);return u.protocol==='https:'&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash} catch{return false}
}
export function authMessage(purpose:'verify'|'reset',origin:string,token:string){
 const link=new URL('/auth',origin);link.hash=new URLSearchParams({action:purpose,token}).toString();
 const title=purpose==='verify'?'Подтвердите email в Criterion':'Сброс пароля Criterion';
 const instruction=purpose==='verify'?'Подтвердите адрес в том браузере, где вы вошли в Criterion.':'Откройте ссылку и задайте новый пароль. Текущие сеансы будут завершены.';
 const ttl=purpose==='verify'?'24 часа':'30 минут';
 return {subject:title,text:`${title}\n\n${instruction}\n\n${link.href}\n\nСсылка действует ${ttl} и используется один раз. Если вы не запрашивали это письмо, просто проигнорируйте его. Никому не пересылайте ссылку.\n\nCriterion`};
}
export async function sendAuthMail(config:MailConfig,to:string,purpose:'verify'|'reset',token:string,idempotencyKey:string,transport:typeof fetch=fetch){
 if(!mailReady(config))throw new Error('MAIL_NOT_CONFIGURED');
 const message=authMessage(purpose,config.AUTH_PUBLIC_URL!,token);
 const response=await transport('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${config.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':idempotencyKey},body:JSON.stringify({from:config.EMAIL_FROM,to:[to],...message}),signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw new Error('MAIL_PROVIDER_REJECTED');
 const result=await response.json() as {id?:string};if(!result.id)throw new Error('MAIL_PROVIDER_INVALID_RESPONSE');
 return result.id;
}
