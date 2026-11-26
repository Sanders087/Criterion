import { diagnostic } from '../diagnostics.mjs';
import { runRequestContext, runOperation } from '../request-context.mjs';
import { AppError, HttpError, errorDetails, normalizeError } from './app-error.ts';

function logFailure(event: 'http.request_failed' | 'operation.failed', error: AppError, fields = {}, level = 'error') {
  const write = () => diagnostic(event, { ...errorDetails(error), ...fields }, level);
  if (error.operationId) runOperation(write, error.operationId);
  else write();
}

export function apiRoute<Args extends unknown[]>(route: string,
  handler: (request: Request, ...args: Args) => Promise<Response>) {
  return (request: Request, ...args: Args): Promise<Response> => runRequestContext(route, async ({ requestId }) => {
    const method = request.method;
    const started = performance.now();
    diagnostic('http.request_started', { method });
    try {
      const response = await handler(request, ...args);
      response.headers.set('X-Request-ID', requestId);
      diagnostic('http.request_completed', { method, httpStatus: response.status,
        durationMs: Math.round(performance.now() - started) });
      return response;
    } catch (cause) {
      const error = normalizeError(cause);
      const level = error.status >= 500 ? 'error' : error.status === 429 ? 'warn' : 'info';
      logFailure('http.request_failed', error, { method, httpStatus: error.status, operationDurationMs: error.operationDurationMs,
        durationMs: Math.round(performance.now() - started) }, level);
      return Response.json({ error: error.publicMessage, code: error.code, requestId,
        ...(route === '/api/health' ? { status: 'unavailable' } : {}) }, {
        status: error.status, headers: { 'X-Request-ID': requestId,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
      });
    }
  });
}

// The HTTP boundary reports propagated errors. A deliberately suppressed error
// (e.g. a generic password-reset response) is reported by its caller instead.
export function observeOperation<T>(component: 'ai' | 'mail', stage: 'generation' | 'mail_delivery', work: () => Promise<T>): Promise<T> {
  return runOperation(async () => {
    const started = performance.now();
    diagnostic('operation.started', { component, stage });
    try {
      const value = await work();
      diagnostic('operation.completed', { component, stage, durationMs: Math.round(performance.now() - started) });
      return value;
    } catch (cause) {
      const error = normalizeError(cause);
      error.operationDurationMs = Math.round(performance.now() - started);
      throw error;
    }
  });
}

export function reportSuppressed(cause: unknown) {
  const error = normalizeError(cause);
  logFailure('operation.failed', error, { durationMs: error.operationDurationMs });
}

// Mirror Next's automatic OPTIONS and HEAD behavior for supported methods.
// Explicit exports ensure framework-generated 405s on known endpoints also receive an ID.
export function apiDefaults(route: string, supported: readonly string[]) {
  const allow = [...supported, ...(supported.includes('GET') ? ['HEAD'] : []), 'OPTIONS'].sort().join(', ');
  const OPTIONS = apiRoute(route, async () => new Response(null, { status: 204, headers: { Allow: allow } }));
  const reject = apiRoute(route, async () => { throw new HttpError(405, 'Метод не поддерживается.'); });
  const unsupported = async (request: Request) => {
    const response = await reject(request);
    response.headers.set('Allow', allow);
    return response;
  };
  return { GET: unsupported, HEAD: unsupported, POST: unsupported, PUT: unsupported,
    PATCH: unsupported, DELETE: unsupported, OPTIONS };
}
