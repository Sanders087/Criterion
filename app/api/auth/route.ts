import {env} from 'cloudflare:workers';
import {mailReady} from '../../../lib/criterion/mail';
import {mailConfig,issueEmail} from '../../../lib/criterion/email-tokens';
import {z} from 'zod';
import {getChatGPTUser} from '../../chatgpt-auth';
import {digest,passwordHash,randomToken,equal,sessionToken,sessionCookie,getAccount} from '../../../lib/criterion/auth';
import {failure,HttpError,json} from '../../../lib/criterion/server';
export async function GET(){try{const [user,legacy]=await Promise.all([getAccount(),getChatGPTUser()]);return json({user,legacyAvailable:!!legacy,mailReady:mailReady(mailConfig())})}catch(e){return failure(e)}}
export async function POST(request:Request){try{
 const origin=request.headers.get('origin');if(!origin||new URL(origin).origin!==new URL(request.url).origin||request.headers.get('sec-fetch-site')==='cross-site')throw new HttpError(403,'Запрос должен исходить из этого приложения.');
 if(!request.headers.get('content-type')?.includes('application/json'))throw new HttpError(415,'Ожидается JSON.');
 const raw=await request.text();if(raw.length>4096)throw new HttpError(413,'Слишком большой запрос.');
 const data=z.object({action:z.enum(['register','login','logout','recover']),email:z.string().trim().email().max(254).optional(),password:z.string().max(256).optional(),recoveryCode:z.string().max(100).optional(),linkLegacy:z.boolean().optional()}).parse(JSON.parse(raw));
 const now=Date.now();
 if(data.action==='logout'){const token=sessionToken(request.headers);if(token)await env.DB!.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(token)).run();return Response.json({ok:true},{headers:{'Set-Cookie':sessionCookie('',0),'Cache-Control':'no-store'}})}
 const email=data.email?.toLowerCase();if(!email||!data.password)throw new HttpError(400,'Введите email и пароль.');
 // Atomic fixed-window limits, per IP and email. No secrets are stored in limit keys.
 const ip=request.headers.get('cf-connecting-ip')||'unknown';
 for(const [scope,limit] of [['ip:'+ip,40],['email:'+email,10]] as const){const key=await digest(scope);const row=await env.DB!.prepare('INSERT INTO auth_limits (key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END, expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count').bind(key,now+15*60*1000,now,now).first<{count:number}>();if((row?.count||0)>limit)throw new HttpError(429,'Слишком много попыток. Повторите через 15 минут.');}
 let account=await env.DB!.prepare('SELECT * FROM accounts WHERE email=?').bind(email).first<{id:string,email:string,password_hash:string,salt:string,recovery_hash:string}>();
 let recoveryCode:string|undefined;
 if(data.action==='register'){
  if(data.password.length<12)throw new HttpError(400,'Пароль должен содержать не менее 12 символов.');
  if(account)throw new HttpError(400,'Не удалось зарегистрировать аккаунт. Попробуйте войти или восстановить доступ.');
  const legacy=data.linkLegacy?await getChatGPTUser():null;if(data.linkLegacy&&!legacy)throw new HttpError(401,'Сначала подтвердите прежний аккаунт.');
  const id=legacy?.userId||'email:'+crypto.randomUUID();
  if(await env.DB!.prepare('SELECT id FROM accounts WHERE id=?').bind(id).first())throw new HttpError(409,'Для прежнего аккаунта уже настроен вход по email. Войдите в него.');
  const salt=randomToken();recoveryCode=randomToken();const hash=await passwordHash(data.password,salt);
  const result=await env.DB!.prepare('INSERT OR IGNORE INTO accounts (id,email,password_hash,salt,recovery_hash,created_at) VALUES (?,?,?,?,?,?)').bind(id,email,hash,salt,await digest(recoveryCode),now).run();
  if(result.meta.changes!==1)throw new HttpError(409,'Аккаунт уже зарегистрирован. Войдите.');
  account={id,email,password_hash:hash,salt,recovery_hash:await digest(recoveryCode)};
 }else if(data.action==='recover'){
  const valid=equal(await digest(data.recoveryCode||''),account?.recovery_hash||'0'.repeat(64));if(!account||!valid)throw new HttpError(401,'Email или код восстановления неверен.');
  if(data.password.length<12)throw new HttpError(400,'Пароль должен содержать не менее 12 символов.');
  const salt=randomToken();recoveryCode=randomToken();const hash=await passwordHash(data.password,salt);
  const results=await env.DB!.batch([env.DB!.prepare('UPDATE accounts SET password_hash=?,salt=?,recovery_hash=? WHERE id=? AND recovery_hash=?').bind(hash,salt,await digest(recoveryCode),account.id,account.recovery_hash),env.DB!.prepare('DELETE FROM sessions WHERE account_id=?').bind(account.id)]);
  if(results[0].meta.changes!==1)throw new HttpError(401,'Код уже использован.');
 }else{
  const hash=await passwordHash(data.password,account?.salt||'0'.repeat(64));if(!account||!equal(hash,account.password_hash))throw new HttpError(401,'Неверный email или пароль.');
 }
 const token=randomToken();await env.DB!.prepare('INSERT INTO sessions (token_hash,account_id,expires_at) VALUES (?,?,?)').bind(await digest(token),account!.id,now+14*86400000).run();
 await env.DB!.batch([env.DB!.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(now),env.DB!.prepare('DELETE FROM auth_limits WHERE expires_at<=?').bind(now)]);
 let verificationSent=false;
 if(data.action==='register'&&mailReady(mailConfig())){try{await issueEmail(account!.id,'verify');verificationSent=true}catch{console.error('Criterion verification mail delivery failed')}}
 return Response.json({ok:true,verificationSent,...(recoveryCode?{recoveryCode}:{})},{headers:{'Set-Cookie':sessionCookie(token),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}catch(e){return failure(e)}}
