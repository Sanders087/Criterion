import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateMonitoringAuthorized } from '../lib/server/monitoring-auth.ts';
import { integrationObservation, observeIntegrations } from '../lib/diagnostic-integrations.mjs';

test('private monitoring requires its own configured authorization header', () => {
  const original = process.env.MONITORING_TOKEN;
  const secret = 'synthetic-service-monitoring-secret-79';
  const headers = { authorization: 'Bearer ' + secret };
  const endpoint = 'https://criterion.test/api/health/integrations';
  try {
    delete process.env.MONITORING_TOKEN;
    assert.equal(privateMonitoringAuthorized(new Request(endpoint, { headers })), false);
    process.env.MONITORING_TOKEN = 'weak';
    assert.equal(privateMonitoringAuthorized(new Request(endpoint, { headers:{ authorization:'Bearer weak' } })), false);
    process.env.MONITORING_TOKEN = secret;
    assert.equal(privateMonitoringAuthorized(new Request(endpoint + '?token=' + secret, { headers:{ cookie:'token='+secret } })), false);
    assert.equal(privateMonitoringAuthorized(new Request(endpoint, { headers:{ authorization:'Bearer '+secret+'x' } })), false);
    assert.equal(privateMonitoringAuthorized(new Request(endpoint, { headers })), true);
  } finally {
    if (original === undefined) delete process.env.MONITORING_TOKEN;
    else process.env.MONITORING_TOKEN = original;
  }
});

test('observed state distinguishes confirmed responses, failures and expired evidence', () => {
  assert.deepEqual(integrationObservation('ai'), { reachable:'unknown', functional:'unknown', lastCheckedAt:null });
  observeIntegrations('ai.request_started', {});
  observeIntegrations('ai.request_failed', { errorCode:'AI_CONFIG_INVALID' });
  assert.equal(integrationObservation('ai').lastCheckedAt, null);
  observeIntegrations('ai.response_validation_failed', {});
  assert.equal(integrationObservation('ai').functional, false);
  observeIntegrations('ai.response_validated', {});
  const recent = integrationObservation('ai');
  assert.equal(recent.functional, true);
  assert.equal(recent.reachable, true);
  assert.deepEqual(integrationObservation('ai', Date.parse(recent.lastCheckedAt) + 300_000), {
    functional:'unknown', reachable:'unknown', lastCheckedAt: recent.lastCheckedAt,
  });

  observeIntegrations('payment.transport_failed', { component:'payment_site', stage:'gateway_request', errorCode:'GATEWAY_HTTP_ERROR', upstreamStatus:503 });
  assert.equal(integrationObservation('bank').lastCheckedAt, null);
  assert.equal(integrationObservation('paymentGateway').functional, false);
  observeIntegrations('payment.transport_failed', { component:'payment_site', stage:'gateway_request', errorCode:'BANK_TIMEOUT', upstreamStatus:504 });
  assert.equal(integrationObservation('bank').reachable, 'unknown');
  assert.equal(integrationObservation('paymentGateway').functional, true);
  observeIntegrations('payment.transport_completed', { component:'payment_site', stage:'gateway_request', upstreamStatus:200 });
  assert.equal(integrationObservation('bank').functional, true);
  observeIntegrations('mail.outcome_unknown', {});
  assert.equal(integrationObservation('resend').functional, 'unknown');
  observeIntegrations('mail.provider_accepted', {});
  assert.equal(integrationObservation('resend').functional, true);
  observeIntegrations('pii.stage_completed', { stage:'input_validation' });
  assert.equal(integrationObservation('piiDetector').functional, 'unknown');
  observeIntegrations('pii.stage_completed', { stage:'detector_response_validation' });
  assert.equal(integrationObservation('piiDetector').functional, true);
});
