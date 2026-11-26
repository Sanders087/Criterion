// Only outcomes of real business requests provide evidence about external providers.
const stateKey = Symbol.for('criterion.integration-observations.v1');
const samples = globalThis[stateKey] ??= new Map();
const freshnessMs = 5 * 60_000;

function remember(component, reachable, functional) {
  samples.set(component, { reachable, functional, time: Date.now() });
}

export function integrationObservation(component, now = Date.now()) {
  const sample = samples.get(component);
  const fresh = sample && now - sample.time < freshnessMs;
  return {
    reachable: fresh ? sample.reachable : 'unknown',
    functional: fresh ? sample.functional : 'unknown',
    lastCheckedAt: sample ? new Date(sample.time).toISOString() : null,
  };
}

export function observeIntegrations(event, detail) {
  switch (event) {
    case 'mail.provider_accepted': return remember('resend', true, true);
    case 'mail.provider_rejected': return remember('resend', true, false);
    case 'mail.outcome_unknown':
      return remember('resend', detail.upstreamStatus ? true : 'unknown', 'unknown');
    case 'ai.response_validated': return remember('ai', true, true);
    case 'ai.response_validation_failed': return remember('ai', true, false);
    case 'ai.request_failed':
      if (detail.errorCode === 'AI_CONFIG_INVALID') return;
      if (detail.errorCode === 'AI_PII_RESTORE_FAILED') return remember('ai', true, 'unknown');
      return remember('ai', detail.upstreamStatus ? true : 'unknown', false);
    case 'pii.stage_completed':
      if (detail.stage === 'detector_response_validation') remember('piiDetector', true, true);
      return;
    case 'pii.stage_failed':
      if (detail.stage === 'detector_response_validation') remember('piiDetector', true, false);
      else if (detail.stage === 'detector_request' && detail.errorCode !== 'PII_CONFIG_INVALID')
        remember('piiDetector', detail.upstreamStatus ? true : 'unknown', false);
      return;
    case 'payment.transport_completed':
    case 'payment.transport_failed': {
      if (detail.component !== 'payment_site') return;
      const success = event === 'payment.transport_completed';
      const code = detail.errorCode ?? '';
      const viaGateway = detail.stage === 'gateway_request' || code.startsWith('GATEWAY_');
      if (viaGateway) {
        const forwardedFailure = code.startsWith('BANK_');
        remember('paymentGateway', success || detail.upstreamStatus ? true : 'unknown', success || forwardedFailure);
        if (!success && !forwardedFailure) return;
        const bankResponded = success || ['BANK_REQUEST_REJECTED','BANK_HTTP_ERROR','BANK_RESPONSE_INVALID'].includes(code);
        remember('bank', bankResponded ? true : 'unknown', success);
      } else if (detail.stage === 'bank_request' || code.startsWith('BANK_')) {
        remember('bank', success || detail.upstreamStatus ? true : 'unknown', success);
      }
      return;
    }
  }
}
