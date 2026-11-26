import { PrivacyError, type Detection, type PiiDetector } from './privacy.ts';

export type PrivacyEnv = {
  PII_ANALYZER_URL?: string;
  PII_ANALYZER_TOKEN?: string;
};

/**
 * This endpoint MUST be hosted inside the operator's trusted infrastructure.
 * It receives plaintext; it is never a third-party "cloud anonymizer".
 */
export function detectorEndpoint(runtime: PrivacyEnv) {
  const token = runtime.PII_ANALYZER_TOKEN;
  if (!runtime.PII_ANALYZER_URL || !token || token.length < 32 || /[\r\n]/.test(token)) {
    throw new PrivacyError('PII_CONFIG_INVALID','detector_request');
  }
  let url: URL;
  try { url = new URL(runtime.PII_ANALYZER_URL); } catch (cause) { throw new PrivacyError('PII_CONFIG_INVALID','detector_request',cause); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      url.pathname !== '/analyze' ||
      !(url.protocol === 'https:' || (loopback && url.protocol === 'http:'))) {
    throw new PrivacyError('PII_CONFIG_INVALID','detector_request');
  }
  return { url, token };
}

export function trustedDetector(runtime: PrivacyEnv): PiiDetector {
  return async (texts) => {
    const { url, token } = detectorEndpoint(runtime);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts }),
        // Workers supports manual, not error; non-2xx responses are rejected below.
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new PrivacyError('PII_HTTP_ERROR','detector_request',undefined,response.status);
      }
      // Do not trust Content-Length alone or log an error body containing input.
      const reader = response.body?.getReader();
      if (!reader) throw new PrivacyError('PII_RESPONSE_INVALID','detector_response_validation');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2_000_000) {
            await reader.cancel().catch(() => {});
            throw new PrivacyError('PII_RESPONSE_TOO_LARGE','detector_response_validation');
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Detection; }
      catch (cause) { throw new PrivacyError('PII_RESPONSE_INVALID','detector_response_validation',cause); }
    } catch (cause) {
      if (cause instanceof PrivacyError) throw cause;
      const timeout = cause instanceof Error && ['TimeoutError','AbortError'].includes(cause.name);
      throw new PrivacyError(timeout ? 'PII_TIMEOUT' : 'PII_HTTP_ERROR','detector_request',cause);
    }
  };
}
