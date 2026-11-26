import {checkLimit} from '../../../../lib/criterion/rate-limit';
import {sameOrigin,clientAddress} from '../../../../lib/criterion/request-security';
import {reportSuppressed} from '../../../../lib/criterion/api-observability';
import {env} from '../../../../lib/runtime';
import {z} from 'zod';
import {digest,getAccount,passwordHash,randomToken,sessionCookie} from '../../../../lib/criterion/auth';
import {mailReady} from '../../../../lib/criterion/mail';
import {issueEmail,mailConfig,mailConfigurationError,mailRequest,skipMail} from '../../../../lib/criterion/email-tokens';
import {apiDefaults, apiRoute,HttpError,json,parseBodyJson} from '../../../../lib/criterion/server';
const generic='Если адрес подтверждён и связан с аккаунтом, мы отправим ссылку для сброса пароля. Проверьте входящие и спам.';
export const POST = apiRoute('/api/auth/email', async (request:Request) => {
 if(!sameOrigin(request)||request.headers.get('sec-fetch-site')==='cross-site')throw new HttpError(403,'Запрос должен исходить из этого приложения.');
 if(!request.headers.get('content-type')?.includes('application/json'))throw new HttpError(415,'Ожидается JSON.');
 const raw=await request.text();if(raw.length>4096)throw new HttpError(413,'Слишком большой запрос.');
 const parsed=parseBodyJson(raw);
 const data=inputSchema.parse(parsed);
 if(data.action==='request-reset'||data.action==='send-verification'){
  return mailRequest(data.action==='request-reset'?'reset':'verify',()=>handle(request,data));
 }
 return handle(request,data);
});

const inputSchema=z.object({action:z.enum(['request-reset','send-verification','verify','reset']),email:z.string().trim().email().max(254).optional(),token:z.string().regex(/^[a-f0-9]{64}$/).optional(),password:z.string().min(12).max(256).optional()});

async function handle(request:Request,data:z.infer<typeof inputSchema>){
 const now=Date.now(),db=env.DB!,email=data.email?.toLowerCase();
 const sending=data.action==='request-reset'||data.action==='send-verification';
 const mailType = data.action==='request-reset'?'reset':'verify';
 if(sending&&!mailReady(mailConfig())){
  skipMail(mailType,true);
  throw mailConfigurationError();
 }
 const user=data.action==='send-verification'||data.action==='verify'?await getAccount():null;
 if((data.action==='send-verification'||data.action==='verify')&&!user)throw new HttpError(401,'Войдите в аккаунт в этом браузере и снова откройте ссылку подтверждения.');
 const target=sending?(data.action==='send-verification'?user!.email:email||'email'):(user?.email||await digest(data.token||''));
 const window=sending?3600000:900000;
 const address=clientAddress(request), known=address!=='unknown';
 await checkLimit('mail-ip:'+address,'mail_address',sending?20:40,window,now,known,sending?mailType:undefined);
 await checkLimit('mail-target:'+(sending?'send':'consume')+':'+target,sending?'mail_recipient':'mail_token',sending?3:20,window,now,known,sending?mailType:undefined);
 if(data.action==='send-verification'){
  if(user!.emailVerified){skipMail('verify');return json({ok:true,message:'Email уже подтверждён.'});}
  await issueEmail(user!.userId,'verify');
  return json({ok:true,message:'Письмо подтверждения передано почтовому сервису. Проверьте входящие и спам.'});
 }
 if(data.action==='request-reset'){
  if(!email)throw new HttpError(400,'Введите email.');
  const account=await db.prepare('SELECT id,email_verified_at FROM accounts WHERE email=?').bind(email).first<{id:string,email_verified_at:number|null}>();
  if(account?.email_verified_at){try{await issueEmail(account.id,'reset')}catch(cause){reportSuppressed(cause);}}else{skipMail('reset')}
  return json({ok:true,message:generic});
 }
 if(!data.token)throw new HttpError(400,'Ссылка недействительна.');
 const tokenHash=await digest(data.token);
 if(data.action==='verify'){
  const results=await db.batch([
   db.prepare("UPDATE accounts SET email_verified_at=? WHERE id=? AND EXISTS (SELECT 1 FROM email_tokens t WHERE t.token_hash=? AND t.purpose='verify' AND t.account_id=accounts.id AND t.email=accounts.email AND t.expires_at>? AND t.claim IS NULL)").bind(now,user!.userId,tokenHash,now),
   db.prepare("DELETE FROM email_tokens WHERE token_hash=? AND purpose='verify' AND account_id=?").bind(tokenHash,user!.userId)
  ]);if(results[0].meta.changes!==1)throw new HttpError(400,'Ссылка истекла, уже использована или относится к другому аккаунту.');
  return json({ok:true,message:'Email подтверждён. Теперь можно восстанавливать пароль по почте.'});
 }
 if(!data.password)throw new HttpError(400,'Введите новый пароль.');
 const salt=randomToken(),hash=await passwordHash(data.password,salt),recoveryCode=randomToken(),claim=randomToken();
 const results=await db.batch([
  db.prepare("UPDATE email_tokens SET claim=? WHERE token_hash=? AND purpose='reset' AND expires_at>? AND claim IS NULL AND EXISTS (SELECT 1 FROM accounts a WHERE a.id=email_tokens.account_id AND a.email=email_tokens.email AND a.email_verified_at IS NOT NULL AND a.password_hash=email_tokens.credential_hash)").bind(claim,tokenHash,now),
  db.prepare('UPDATE accounts SET password_hash=?,salt=?,recovery_hash=? WHERE id IN (SELECT account_id FROM email_tokens WHERE token_hash=? AND claim=?)').bind(hash,salt,await digest(recoveryCode),tokenHash,claim),
  db.prepare('DELETE FROM sessions WHERE account_id IN (SELECT account_id FROM email_tokens WHERE token_hash=? AND claim=?)').bind(tokenHash,claim)
 ]);
 if(results[0].meta.changes!==1)throw new HttpError(400,'Ссылка истекла или уже использована. Запросите новую.');
 return Response.json({ok:true,recoveryCode,message:'Пароль изменён. Войдите с новым паролем.'},{headers:{'Cache-Control':'no-store','Set-Cookie':sessionCookie('',0)}});
}

export const { GET, HEAD, PUT, PATCH, DELETE, OPTIONS } = apiDefaults('/api/auth/email', ['POST']);
