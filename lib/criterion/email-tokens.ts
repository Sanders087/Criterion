import {env} from 'cloudflare:workers';
import {digest,randomToken} from './auth';
import {sendAuthMail,type MailConfig,mailReady} from './mail';
export const mailConfig=()=>env as Cloudflare.Env & MailConfig;
export async function issueEmail(accountId:string,purpose:'verify'|'reset'){
 const config=mailConfig();if(!mailReady(config))throw new Error('MAIL_NOT_CONFIGURED');
 const account=await env.DB!.prepare('SELECT email,password_hash FROM accounts WHERE id=?').bind(accountId).first<{email:string,password_hash:string}>();if(!account)throw new Error('ACCOUNT_NOT_FOUND');
 const token=randomToken(),hash=await digest(token),now=Date.now();
 await env.DB!.batch([env.DB!.prepare('DELETE FROM email_tokens WHERE expires_at<=?').bind(now),env.DB!.prepare('INSERT INTO email_tokens (token_hash,account_id,email,purpose,credential_hash,expires_at) VALUES (?,?,?,?,?,?)').bind(hash,accountId,account.email,purpose,account.password_hash,now+(purpose==='verify'?86400000:1800000))]);
 try{await sendAuthMail(config,account.email,purpose,token,'criterion-'+hash)}catch{await env.DB!.prepare('DELETE FROM email_tokens WHERE token_hash=?').bind(hash).run();throw new Error('MAIL_SEND_FAILED')}
}
