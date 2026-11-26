import { diagnostic } from '../diagnostics.mjs';
import { env } from '../runtime';
import { digest } from './auth';
import { HttpError } from './app-error';

type Scope = 'auth_address'|'auth_recipient'|'mail_address'|'mail_recipient'|'mail_token';
export async function checkLimit(keyMaterial: string, limitType: Scope, limit: number, windowMs: number,
  now: number, addressKnown: boolean, mailType?: 'verify'|'reset') {
  const row = await env.DB!.prepare(`INSERT INTO auth_limits (key,count,expires_at) VALUES (?,1,?)
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,
    expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count, expires_at`)
    .bind(await digest(keyMaterial),now+windowMs,now,now).first<{count:number,expires_at:number}>();
  if (!row) throw new Error('Rate limit update failed');
  const isAddress = limitType === 'auth_address' || limitType === 'mail_address';
  // Keep each recipient/token limit when ingress cannot supply an address.
  // The shared fallback is a higher emergency ceiling, not one ordinary IP's quota.
  if (isAddress && !addressKnown) {
    diagnostic('rate_limit.client_address_unknown', {limitType,addressKnown:false}, 'warn');
  }
  const ceiling = isAddress && !addressKnown ? limit * 10 : limit;
  if (row.count <= ceiling) return;
  const retryAfterSeconds = Math.max(1,Math.ceil((row.expires_at-now)/1000));
  diagnostic('rate_limit.exceeded',{limitType,addressKnown,retryAfterSeconds},'warn');
  if (mailType) diagnostic('mail.rate_limited',{mailType,status:'RATE_LIMITED',retryAfterSeconds},'warn');
  const error = new HttpError(429,'Слишком много запросов. Попробуйте позже.');
  error.retryAfterSeconds = retryAfterSeconds;
  throw error;
}
