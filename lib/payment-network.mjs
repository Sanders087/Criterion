// Shared site/gateway transport vocabulary. Only constants cross the trust boundary.
export const CONNECT_MS = 3000;
export const BANK_MS = 12000;
export const SITE_MS = 15000;
const suffixes = ['DNS_ERROR', 'CONNECTION_REFUSED', 'CONNECT_TIMEOUT', 'TLS_ERROR',
  'TIMEOUT', 'HTTP_ERROR', 'RESPONSE_INVALID', 'NETWORK_ERROR', 'RESPONSE_INTERRUPTED'];
const bankCodes = new Set([...suffixes.map(s => 'BANK_' + s), 'BANK_REQUEST_REJECTED']);
export function isBankCode(value) { return bankCodes.has(value); }
export function traceInput(signature, requestId, operationId) {
  return ['criterion-trace-v1', signature, requestId, operationId].join('\n');
}
export function validBankEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.Success !== 'boolean') return false;
  const code = value.ErrorCode;
  if (typeof code !== 'string' && !Number.isSafeInteger(code)) return false;
  if (value.Success) return code === '0' || code === 0;
  // T-Bank publishes signed decimal error codes (including -948). An unreadable
  // denial must not release the order: Init may already have created a payment.
  const text = String(code);
  return /^-?[1-9][0-9]*$/u.test(text) && !/\s/u.test(text);
}

export function retryableRead(method, code, status) {
  if (method !== 'GetState' && method !== 'CheckOrder') return false;
  if (code.endsWith('_HTTP_ERROR')) return [408, 429, 502, 503, 504].includes(status);
  return ['_CONNECTION_REFUSED', '_CONNECT_TIMEOUT', '_TIMEOUT', '_RESPONSE_INTERRUPTED']
    .some(suffix => code.endsWith(suffix));
}

// Node fetch wraps transport errors in TypeError.cause. Never classify using raw messages.
export function networkCode(error, gateway, reading = false) {
  const prefix = gateway ? 'GATEWAY_' : 'BANK_';
  const seen = new Set();
  for (let current = error; current && !seen.has(current) && seen.size < 5; current = current.cause) {
    seen.add(current);
    const code = current.code;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return prefix + 'DNS_ERROR';
    if (code === 'ECONNREFUSED') return prefix + 'CONNECTION_REFUSED';
    if (code === 'UND_ERR_CONNECT_TIMEOUT' || (code === 'ETIMEDOUT' && current.syscall === 'connect')) return prefix + 'CONNECT_TIMEOUT';
    if (typeof code === 'string' && /^(?:ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_(?:VERIFY|GET)_)/.test(code)) return prefix + 'TLS_ERROR';
    if (['TimeoutError', 'AbortError'].includes(current.name) || ['ABORT_ERR','ETIMEDOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(code)) return prefix + 'TIMEOUT';
    if (['ECONNRESET','EPIPE','UND_ERR_SOCKET','ERR_STREAM_PREMATURE_CLOSE'].includes(code) && reading) return prefix + 'RESPONSE_INTERRUPTED';
  }
  return prefix + 'NETWORK_ERROR';
}
