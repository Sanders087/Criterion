export const databaseErrorCodes = ['DB_BUSY','DB_LOCKED','DB_READONLY','DB_FULL','DB_PERMISSION_DENIED',
  'DB_IO_ERROR','DB_CORRUPT','DB_TRANSACTION_FAILED'];

const primary = new Map([
  [3,['SQLITE_PERM','DB_PERMISSION_DENIED']], [5,['SQLITE_BUSY','DB_BUSY']], [6,['SQLITE_LOCKED','DB_LOCKED']],
  [8,['SQLITE_READONLY','DB_READONLY']], [10,['SQLITE_IOERR','DB_IO_ERROR']], [11,['SQLITE_CORRUPT','DB_CORRUPT']],
  [13,['SQLITE_FULL','DB_FULL']], [14,['SQLITE_CANTOPEN','DB_IO_ERROR']], [19,['SQLITE_CONSTRAINT','DATABASE_ERROR']],
  [23,['SQLITE_AUTH','DB_PERMISSION_DENIED']], [26,['SQLITE_NOTADB','DB_CORRUPT']],
]);
const extended = new Map([[261,'SQLITE_BUSY_RECOVERY'],[517,'SQLITE_BUSY_SNAPSHOT'],[773,'SQLITE_BUSY_TIMEOUT'],
  [262,'SQLITE_LOCKED_SHAREDCACHE'],[520,'SQLITE_READONLY_CANTLOCK'],[1032,'SQLITE_READONLY_DBMOVED']]);
export const databaseTechnicalCodes = [...primary.values()].map(([name]) => name).concat([...extended.values()]);
const posixErrors = { EACCES:'DB_PERMISSION_DENIED', EPERM:'DB_PERMISSION_DENIED', EROFS:'DB_READONLY',
  ENOSPC:'DB_FULL', EIO:'DB_IO_ERROR' };

/** Read only standard error properties. Drizzle can wrap a native error in cause. */
export function databaseFailure(error) {
  let current = error;
  const seen = new Set();
  while (current instanceof Error && !seen.has(current) && seen.size < 8) {
    seen.add(current);
    const code = Object.getOwnPropertyDescriptor(current,'code')?.value;
    if (typeof code === 'string' && Object.hasOwn(posixErrors,code)) return {errorCode:posixErrors[code],causeCode:code};
    if (typeof code === 'string' && (code === 'ERR_SQLITE_ERROR' || databaseTechnicalCodes.includes(code))) {
      const raw = Object.getOwnPropertyDescriptor(current,'errcode')?.value;
      const numeric = Number.isSafeInteger(raw) && raw > 0 && raw <= 65535 ? raw : undefined;
      const base = numeric === undefined
        ? [...primary.values()].find(([name]) => code === name || code.startsWith(name+'_'))
        : primary.get(numeric & 255);
      return {errorCode:base?.[1] || 'DATABASE_ERROR',causeCode:extended.get(numeric) || base?.[0] || code,
        sqliteResultCode:numeric};
    }
    current = Object.getOwnPropertyDescriptor(current,'cause')?.value;
  }
  return null;
}

export function storageEvents({oneOf,uint,bool,duration,isDiagnosticErrorCode}) {
  const operation = oneOf('auth.create_account','auth.issue_email_token','payment.create_order','payment.apply_notification',
    'payment.apply_bank_state','payment.grant_access','document.create','document.save_revision',
    'database.query','database.transaction','database.migrate');
  const fields = {operation,parentOperation:operation,durationMs:duration};
  return {
    'database.operation_completed':fields,
    'database.operation_failed':{...fields,errorCode:isDiagnosticErrorCode,causeCode:isDiagnosticErrorCode,sqliteResultCode:uint,
      rolledBack:bool,rollbackFailed:bool,busyTimeoutMs:uint,busyTimeoutElapsed:bool},
    'storage.backup_job_failed':{reason:oneOf('spawn_failed','helper_failed')},
    'storage.health':{databaseBytes:uint,walBytes:uint,freeBytes:uint,writable:bool,
      backupStatus:oneOf('ok','failed','unknown'),lastSuccessTimestampSeconds:uint},
  };
}
