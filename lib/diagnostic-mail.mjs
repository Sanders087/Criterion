export const mailErrorCodes = ['MAIL_CONFIG_INVALID', 'MAIL_PROVIDER_REJECTED', 'MAIL_OUTCOME_UNKNOWN'];
export const mailStages = [];

export function mailEvents({oneOf, uint, bool, duration, httpStatus, isDiagnosticErrorCode}) {
  const mailType = oneOf('verify','reset');
  const providerMessageId = value => typeof value === 'string' && value.length === 36 &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
  const errorCode = oneOf(...mailErrorCodes);
  const failure = { mailType, durationMs: duration, errorCode, upstreamStatus: httpStatus };
  const limit = { limitType: oneOf('auth_address','auth_recipient','mail_address','mail_recipient','mail_token','payment_order'),
    addressKnown: bool, retryAfterSeconds: uint };
  return {
    'mail.request_received': { mailType, status: oneOf('REQUEST_ACCEPTED') },
    'mail.send_started': { mailType },
    'mail.send_skipped': { mailType, status: oneOf('SKIPPED','CONFIG_INVALID'), errorCode },
    'mail.provider_accepted': { mailType, durationMs: duration, providerMessageId, status: oneOf('PROVIDER_ACCEPTED') },
    'mail.status_save_failed': { mailType, status: oneOf('PROVIDER_ACCEPTED'), errorCode:isDiagnosticErrorCode },
    'mail.provider_rejected': { ...failure, status: oneOf('PROVIDER_REJECTED') },
    'mail.outcome_unknown': { ...failure, status: oneOf('OUTCOME_UNKNOWN') },
    'mail.rate_limited': { mailType, status: oneOf('RATE_LIMITED'), retryAfterSeconds: uint },
    'rate_limit.exceeded': limit,
    'rate_limit.client_address_unknown': { limitType: limit.limitType, addressKnown: bool },
    'rate_limit.configuration_invalid': { addressKnown: bool },
  };
}
