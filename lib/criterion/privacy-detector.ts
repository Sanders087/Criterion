import { PrivacyError, type Detection, type PiiDetector } from './privacy.ts';

export type PrivacyEnv = {
  PII_ANALYZER_URL?: string;
  PII_ANALYZER_TOKEN?: string;
};

/**
 * This endpoint MUST be hosted inside the operator's trusted infrastructure.
 * It receives plaintext; it is never a third-party "cloud anonymizer".
 */
export function trustedDetector(runtime: PrivacyEnv): PiiDetector {
  return async (texts) => {
    const token = runtime.PII_ANALYZER_TOKEN;
    if (!runtime.PII_ANALYZER_URL || !token || token.length < 32 || /[\r\n]/.test(token)) {
      throw new PrivacyError();
    }
    let url: URL;
    try { url = new URL(runtime.PII_ANALYZER_URL); } catch (cause) { throw new PrivacyError(cause); }
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash ||
        url.pathname !== '/analyze' ||
        !(url.protocol === 'https:' || (loopback && url.protocol === 'http:'))) {
      throw new PrivacyError();
    }
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts }),
        // Workers supports manual, not error; non-2xx responses are rejected below.
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new PrivacyError();
      // Do not trust Content-Length alone or log an error body containing input.
      const reader = response.body?.getReader();
      if (!reader) throw new PrivacyError();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2_000_000) {
            await reader.cancel();
            throw new PrivacyError();
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Detection;
    } catch (cause) {
      if (cause instanceof PrivacyError) throw cause;
      throw new PrivacyError(cause);
    }
  };
}
