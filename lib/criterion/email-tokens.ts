import { diagnostic } from '../diagnostics.mjs';
import { getRequestContext, runOperation } from '../request-context.mjs';
import { AppError, normalizeError } from './app-error';
import { env } from '../runtime';
import { digest, randomToken } from './auth';
import { sendAuthMail, type MailConfig, mailReady } from './mail';

type MailType = 'verify' | 'reset';
export const mailConfig = () => env as MailConfig;

export function mailRequest<T>(mailType: MailType, work: () => Promise<T>): Promise<T> {
  return runOperation(async () => {
    diagnostic('mail.request_received', {mailType, status:'REQUEST_ACCEPTED'});
    return work();
  });
}
export function skipMail(mailType: MailType, invalidConfig = false) {
  diagnostic('mail.send_skipped', {mailType, status:invalidConfig ? 'CONFIG_INVALID' : 'SKIPPED',
    ...(invalidConfig ? {errorCode:'MAIL_CONFIG_INVALID'} : {})}, invalidConfig ? 'error' : 'info');
}
export function mailConfigurationError() {
  return new AppError({status:503,code:'MAIL_CONFIG_INVALID',
    publicMessage:'Отправка писем пока недоступна. Используйте сохранённый код восстановления.',
    service:'mail',stage:'configuration'});
}
export async function issueEmail(accountId: string, mailType: MailType) {
  const operationId = getRequestContext()?.operationId;
  if (!operationId) throw new Error('Missing mail operation context');
  try { await deliverEmail(accountId, mailType, operationId); }
  catch (cause) {
    if (cause instanceof AppError && cause.status === 503) throw cause;
    const reason = normalizeError(cause);
    throw new AppError({ status:503, code:'MAIL_SEND_FAILED', publicMessage:'Не удалось подтвердить отправку письма. Повторите позже.',
      service:reason.service, stage:reason.stage, cause, retryable:false });
  }
}

async function deliverEmail(accountId: string, mailType: MailType, operationId: string) {
  const config = mailConfig();
  if (!mailReady(config)) {
    skipMail(mailType, true);
    throw mailConfigurationError();
  }
  const db = env.DB!;
  const account = await db.prepare('SELECT email,password_hash FROM accounts WHERE id=?').bind(accountId)
    .first<{email:string,password_hash:string}>();
  if (!account) { skipMail(mailType); return; }
  const token = randomToken(), hash = await digest(token), now = Date.now();
  // If the process exits after sending but before processing the response, the durable
  // outcome remains unknown and a link accepted by the provider can still be used.
  await db.batch([
    db.prepare('DELETE FROM email_tokens WHERE expires_at<=?').bind(now),
    db.prepare('INSERT INTO email_tokens (token_hash,account_id,email,purpose,credential_hash,expires_at) VALUES (?,?,?,?,?,?)')
      .bind(hash, accountId, account.email, mailType, account.password_hash, now + (mailType === 'verify' ? 86400000 : 1800000)),
    db.prepare("INSERT INTO mail_attempts(operation_id,mail_type,status,created_at,updated_at) VALUES (?,?,'OUTCOME_UNKNOWN',?,?)")
      .bind(operationId,mailType,now,now),
  ], 'auth.issue_email_token');
  const started = performance.now();
  diagnostic('mail.send_started', {mailType});
  let providerMessageId: string;
  try {
    providerMessageId = await sendAuthMail(config, account.email, mailType, token, 'criterion-' + operationId);
  } catch (cause) {
    const rejected = cause instanceof AppError && cause.code === 'MAIL_PROVIDER_REJECTED';
    const status = rejected ? 'PROVIDER_REJECTED' : 'OUTCOME_UNKNOWN';
    const errorCode = rejected ? 'MAIL_PROVIDER_REJECTED' : 'MAIL_OUTCOME_UNKNOWN';
    const update = db.prepare('UPDATE mail_attempts SET status=?,error_code=?,updated_at=? WHERE operation_id=?')
      .bind(status,errorCode,Date.now(),operationId);
    diagnostic(rejected ? 'mail.provider_rejected' : 'mail.outcome_unknown', {mailType,status,errorCode,
      upstreamStatus:cause instanceof AppError ? cause.upstreamStatus : undefined,
      durationMs:Math.round(performance.now()-started)}, 'error');
    await db.batch(rejected ? [update,db.prepare('DELETE FROM email_tokens WHERE token_hash=?').bind(hash)] : [update]);
    throw cause;
  }
  diagnostic('mail.provider_accepted',{mailType,providerMessageId,status:'PROVIDER_ACCEPTED',durationMs:Math.round(performance.now()-started)});
  try {
    const result = await db.prepare("UPDATE mail_attempts SET status='PROVIDER_ACCEPTED',provider_message_id=?,updated_at=? WHERE operation_id=?")
      .bind(providerMessageId,Date.now(),operationId).run();
    if (result.meta.changes !== 1) throw new Error('Mail attempt missing');
  } catch (cause) {
    // The token was committed before dispatch. A confirmed acceptance still reaches the caller.
    diagnostic('mail.status_save_failed',{mailType,status:'PROVIDER_ACCEPTED',errorCode:normalizeError(cause).code},'error');
  }
}
