export const aiErrorCodes = [
  'PII_CONFIG_INVALID', 'PII_TIMEOUT', 'PII_HTTP_ERROR', 'PII_RESPONSE_TOO_LARGE', 'PII_RESPONSE_INVALID',
  'PII_SPAN_INVALID', 'PII_INPUT_LIMIT', 'PII_RESERVED_MARKER', 'PII_ANONYMIZATION_FAILED', 'PII_RESTORE_FAILED',
  'AI_CONFIG_INVALID', 'AI_NETWORK_ERROR', 'AI_AUTH_FAILED', 'AI_RATE_LIMITED', 'AI_PROVIDER_ERROR', 'AI_TIMEOUT',
  'AI_OUTPUT_TRUNCATED', 'AI_RESPONSE_INVALID', 'AI_SCHEMA_VALIDATION_FAILED', 'AI_DOCUMENT_STRUCTURE_INVALID',
  'AI_PII_RESTORE_FAILED', 'DOCUMENT_SAVE_FAILED',
];
export const aiStages = ['input_validation', 'detector_request', 'detector_response_validation', 'anonymization',
  'ai_processing', 'pii_restoration', 'document_save'];

export function aiEvents({ oneOf, uint, duration, httpStatus, isDiagnosticErrorCode }) {
  const base = { stage: oneOf(...aiStages), durationMs: duration, errorCode: isDiagnosticErrorCode,
    causeCode: isDiagnosticErrorCode, upstreamStatus: httpStatus };
  const pii = { ...base, detectorProfile: oneOf('ru-contract-v1'), entityCount: uint,
    sizeBucket: oneOf('0-1Ki', '1-16Ki', '16-128Ki', '128Ki+') };
  const ai = { ...base, model: oneOf('gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'gpt-4o-mini'),
    providerRequestId: id => typeof id === 'string' && id.length === 36 && /^req_[a-f0-9]{32}$/.test(id),
    inputTokens: uint, outputTokens: uint, finishReason: oneOf('stop','length','content_filter','tool_calls','function_call'),
    schemaValid: value => typeof value === 'boolean' };
  return {
    'pii.stage_completed': pii, 'pii.stage_failed': pii, 'ai.request_started': ai, 'ai.request_completed': ai,
    'ai.request_failed': ai, 'ai.response_validation_failed': ai, 'ai.response_validated': ai,
    'document.revision_save_started': base, 'document.revision_saved': base, 'document.revision_save_failed': base,
  };
}
