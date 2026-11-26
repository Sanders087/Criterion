export const paymentErrorCodes = ['PAYMENT_CHECK_REQUIRED', 'PAYMENT_ACCESS_ERROR'];
export const paymentStages = ['checkout', 'init', 'notification', 'reconciliation', 'access_grant'];

export function paymentEvents({oneOf, duration, isDiagnosticErrorCode, bool, uint}) {
  const orderStatus = oneOf('INITIALIZING', 'INIT_OUTCOME_UNKNOWN', 'INIT_FAILED', 'NEW', 'FORM_SHOWED',
    'PREAUTHORIZING', 'AUTHORIZING', '3DS_CHECKING', '3DS_CHECKED', 'AUTHORIZED', 'CONFIRMING',
    'CONFIRMED', 'AUTH_FAIL', 'REJECTED', 'CANCELED', 'DEADLINE_EXPIRED', 'REVERSED', 'PARTIAL_REFUNDED', 'REFUNDED');
  const reason = oneOf('invalid_signature', 'unknown_terminal', 'unknown_order', 'invalid_format', 'amount_mismatch',
    'payment_mismatch', 'unsupported_status', 'stale_status', 'payment_not_confirmed', 'database', 'access_grant');
  const result = {durationMs: duration, errorCode: isDiagnosticErrorCode, retryable: bool};
  return {
    'payment.reconciliation_result': {result:oneOf('pending','failed','resolved','manual_review'),attempt:uint},
    'payment.checkout_started': {}, 'payment.order_created': {}, 'payment.init_started': {},
    'payment.init_succeeded': {durationMs: duration}, 'payment.init_failed': result,
    'payment.init_outcome_unknown': result, 'payment.status_checked': {status: orderStatus},
    'payment.notification_received': {}, 'payment.notification_rejected': {reason, errorCode: isDiagnosticErrorCode},
    'payment.notification_duplicate': {status: orderStatus},
    'payment.status_changed': {previousStatus: orderStatus, status: orderStatus},
    'payment.access_granted': {}, 'payment.access_grant_failed': result, 'payment.reconciliation_failed': result,
  };
}
