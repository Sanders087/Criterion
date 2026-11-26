// Only the fields in an event's schema can enter the diagnostic stream.
import { dirname, resolve } from 'node:path';
import { validRequestId, validOperationId } from './request-context.mjs';

const oneOf = (...values) => {
  const allowed = new Set(values);
  return value => allowed.has(value);
};
const bool = value => typeof value === 'boolean';
const uint = value => Number.isSafeInteger(value) && value >= 0;
const nullable = validate => value => value === null || validate(value);
const duration = value => Number.isFinite(value) && value >= 0;
const httpStatus = value => Number.isInteger(value) && value >= 100 && value <= 599;
const safePathText = value => typeof value === 'string' && value.length <= 512 &&
  !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value);

function configuredDb() {
  return resolve(process.env.DATABASE_PATH || 'work/criterion.sqlite');
}
function storagePath(value) {
  if (!safePathText(value)) return false;
  const db = configuredDb();
  return [db, dirname(db), db + '-wal', db + '-shm']
    .some(path => path === value || path.replaceAll('\\', '/') === value);
}
function mountPath(value) {
  return safePathText(value) && value.startsWith('/') &&
    (value === '/' || configuredDb() === value || configuredDb().startsWith(value + '/'));
}

export const isTechnicalErrorCode = oneOf(
  'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ENOSPC', 'EROFS', 'EIO', 'EMFILE', 'ENFILE',
  'EBUSY', 'ELOOP', 'ERR_SQLITE_ERROR', 'SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_READONLY',
  'SQLITE_CANTOPEN', 'SQLITE_CORRUPT', 'SQLITE_FULL', 'ECONNRESET', 'ECONNREFUSED',
  'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNABORTED', 'ENETUNREACH', 'EHOSTUNREACH',
  'EPIPE', 'ABORT_ERR', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
);
const paymentErrors = ['DNS_ERROR', 'CONNECTION_REFUSED', 'CONNECT_TIMEOUT', 'TLS_ERROR',
  'TIMEOUT', 'HTTP_ERROR', 'RESPONSE_INVALID', 'NETWORK_ERROR', 'RESPONSE_INTERRUPTED'];
const appError = oneOf('BAD_REQUEST', 'UNAUTHORIZED', 'PAYMENT_REQUIRED', 'FORBIDDEN', 'NOT_FOUND',
  'CONFLICT', 'METHOD_NOT_ALLOWED', 'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE', 'RATE_LIMITED', 'UNAVAILABLE', 'VALIDATION_ERROR',
  'PII_TOKEN_CONFIG', 'PII_URL_CONFIG', 'PORT_CONFIG', 'HEALTH_PATH_CONFIG', 'SITE_COMMAND_CONFIG',
  'PAYMENT_ERROR', 'PAYMENT_UNAVAILABLE', 'INTERNAL_ERROR', 'REQUEST_TIMEOUT', 'AI_TIMEOUT', 'AI_NOT_CONFIGURED', 'AI_UNAVAILABLE', 'AI_INVALID_RESPONSE',
  'AI_RATE_LIMITED', 'MAIL_SEND_FAILED', 'PRIVACY_ERROR', 'DATABASE_ERROR', 'CLEANUP_FAILED', 'BANK_REQUEST_REJECTED',
  ...paymentErrors.flatMap(code => ['BANK_' + code, 'GATEWAY_' + code]));
export const isDiagnosticErrorCode = value => isTechnicalErrorCode(value) || appError(value) || value === 'UNKNOWN';

const file = {
  path: storagePath, exists: nullable(bool), type: oneOf('file', 'directory', 'symlink', 'other'),
  uid: uint, gid: uint, mode: value => typeof value === 'string' && /^0[0-7]{3}$/.test(value),
  sizeBytes: uint, processCanRead: bool, processCanWrite: bool, processCanTraverse: bool, errorCode: isDiagnosticErrorCode,
};
const mount = {
  mountPoint: mountPath, filesystem: oneOf('nfs', 'nfs4', 'overlay', 'ext4', 'ext3', 'ext2', 'tmpfs',
    'xfs', 'btrfs', 'zfs', 'fuse', 'virtiofs', 'ceph', 'unknown'), readOnly: bool, separateMount: bool,
  persistenceVerified: oneOf(false), status: oneOf('not_linux', 'unknown'), errorCode: isDiagnosticErrorCode,
};
const readiness = { status: oneOf('ready', 'unavailable', 'unreachable'), httpStatus };
const serviceComponent = oneOf('PII detector', 'site');
const method = oneOf('GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS');
const route = oneOf('/api/auth', '/api/auth/email', '/api/documents', '/api/documents/[id]', '/api/documents/[id]/export',
  '/api/health', '/api/materials', '/api/payments/checkout', '/api/payments/status', '/api/payments/tbank/notification',
  '/api/workspace');
const error = {
  errorCode: isDiagnosticErrorCode, causeCode: isTechnicalErrorCode, retryable: bool, upstreamStatus: httpStatus,
  stage: oneOf('request', 'validation', 'authorization', 'provider_request', 'provider_response', 'configuration',
    'payment', 'database', 'cleanup', 'privacy', 'generation', 'mail_delivery', 'gateway_request', 'bank_request', 'unknown'),
  component: oneOf('criterion', 'payments', 'gateway', 'ai', 'mail', 'privacy', 'database', 'payment_gateway', 'payment_site')
};
const http = { method, durationMs: duration, httpStatus };
const transport = {
  component: oneOf('payment_gateway', 'payment_site'), stage: oneOf('gateway_request', 'bank_request', 'unknown'),
  bankMethod: oneOf('Init', 'GetState', 'CheckOrder', 'Cancel'), durationMs: duration,
  dnsDurationMs: duration, tcpDurationMs: duration, tlsDurationMs: duration, ttfbMs: duration,
  responseReadDurationMs: duration, connectionReused: bool, addressFamily: oneOf('IPv4', 'IPv6'),
  upstreamStatus: httpStatus, errorCode: isDiagnosticErrorCode, retryable: bool, causeCode: isTechnicalErrorCode,
  requestId: validRequestId, operationId: validOperationId,
};
const schema = {
  'storage.snapshot': {
    phase: oneOf('before_open', 'after_open', 'inspection', 'read_only_inspection'), databasePath: storagePath,
    processUid: nullable(uint), processGid: nullable(uint), directory: file, database: file, wal: file, shm: file, mount,
  },
  'database.inspection': { status: oneOf('ready', 'unavailable'), reason: oneOf('file_unavailable', 'path_not_configured'),
    databasePath: storagePath, queryOk: bool, readOnlyConnection: bool, errorCode: isDiagnosticErrorCode },
  'database.ready': { databasePath: storagePath, existedBeforeOpen: nullable(bool), queryOk: bool, migrationsOk: bool,
    journalMode: oneOf('wal', 'delete', 'persist', 'truncate', 'memory', 'off') },
  'integrations.configuration': { modelKeyConfigured: bool, mailConfigured: bool, paymentsEnabled: bool,
    bankCredentialsConfigured: bool, providerAvailability: oneOf('not_checked') },
  'service.starting': { component: serviceComponent },
  'service.ready': { component: serviceComponent },
  'service.failed': { component: serviceComponent, reason: oneOf('spawn_failed', 'readiness_timeout'), causeCode: isTechnicalErrorCode },
  'service.exited': { component: serviceComponent, exitCode: nullable(uint),
    signal: nullable(oneOf('SIGTERM','SIGINT','SIGKILL','SIGABRT','SIGSEGV','SIGHUP','SIGPIPE')), expected: bool },
  'services.health': { pii: readiness, site: readiness },
  'services.stopping': { exitCode: uint },
  'services.signal': { reason: oneOf('termination_requested') },
  'site.starting': {},
  'startup.failed': { phase: oneOf('configuration', 'database_open_and_migrations', 'site_start', 'supervisor'), errorCode: isDiagnosticErrorCode },
  'http.request_started': { method },
  'http.request_completed': http,
  'http.request_failed': { ...http, ...error },
  'operation.started': error,
  'operation.completed': { ...error, durationMs: duration },
  'operation.failed': { ...error, durationMs: duration },
  'payment.transport_started': transport,
  'payment.transport_completed': transport,
  'payment.transport_failed': transport,
};

function select(input, shape) {
  const result = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
  const proto = Object.getPrototypeOf(input);
  if (proto !== null && proto !== Object.prototype) return result;
  for (const [key, validator] of Object.entries(shape)) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (!property || !Object.hasOwn(property, 'value')) continue;
    const value = property.value;
    if (typeof validator === 'function') {
      if (validator(value)) result[key] = value;
    } else {
      const nested = select(value, validator);
      if (Object.keys(nested).length) result[key] = nested;
    }
  }
  return result;
}

export function diagnosticFields(event, fields, context) {
  if (typeof event !== 'string' || !Object.hasOwn(schema, event)) return;
  return { ...select(fields, schema[event]), ...select(context, { requestId: validRequestId, operationId: validOperationId, route }) };
}
