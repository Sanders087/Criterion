import { ZodError } from 'zod';
import { getRequestContext } from '../request-context.mjs';
import { isTechnicalErrorCode } from '../diagnostic-schema.mjs';

export interface AppErrorOptions {
  code: string;
  status: number;
  publicMessage: string;
  service: string;
  stage: string;
  cause?: unknown;
  retryable?: boolean;
  upstreamStatus?: number;
}

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly publicMessage: string;
  readonly service: string;
  readonly stage: string;
  readonly retryable?: boolean;
  readonly upstreamStatus?: number;
  readonly operationId?: string;
  operationDurationMs?: number;

  constructor(options: AppErrorOptions) {
    super(options.publicMessage, { cause: options.cause });
    this.name = 'AppError';
    this.code = options.code;
    this.status = options.status;
    this.publicMessage = options.publicMessage;
    this.service = options.service;
    this.stage = options.stage;
    this.retryable = options.retryable;
    this.upstreamStatus = options.upstreamStatus;
    this.operationId = getRequestContext()?.operationId;
  }
}

const httpCodes: Record<number, string> = {
  400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 402: 'PAYMENT_REQUIRED', 403: 'FORBIDDEN',
  404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED', 503: 'UNAVAILABLE', 504: 'REQUEST_TIMEOUT',
};

export class HttpError extends AppError {
  constructor(status: number, publicMessage: string, cause?: unknown) {
    super({ status, publicMessage, cause, code: httpCodes[status] || 'INTERNAL_ERROR',
      service: 'criterion', stage: status === 401 || status === 403 ? 'authorization' : 'request' });
  }
}

// Never stringify an exception, its message, its stack, or arbitrary metadata.
export function technicalCause(error: unknown): string | undefined {
  const visited = new Set<object>();
  let current = error;
  for (let i = 0; i < 5 && current instanceof Error && !visited.has(current); i++) {
    visited.add(current);
    const code = Object.getOwnPropertyDescriptor(current, 'code')?.value;
    if (typeof code === 'string' && isTechnicalErrorCode(code)) return code;
    current = Object.getOwnPropertyDescriptor(current, 'cause')?.value;
  }
  return undefined;
}

export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) return new AppError({ status: 400, code: 'VALIDATION_ERROR',
    publicMessage: 'Проверьте формат данных и длину текста. Изменения не сохранены.',
    service: 'criterion', stage: 'validation', cause: error });
  const causeCode = technicalCause(error);
  if (causeCode && (causeCode.startsWith('SQLITE_') || causeCode.startsWith('ERR_SQLITE_'))) {
    return new AppError({ status: 500, code: 'DATABASE_ERROR', publicMessage: 'Не удалось выполнить операцию с базой данных.',
      service: 'database', stage: 'database', cause: error });
  }
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
    return new HttpError(504, 'Время ожидания истекло. Проверьте состояние операции.', error);
  }
  return new AppError({ status: 500, code: 'INTERNAL_ERROR', service: 'criterion', stage: 'request',
    publicMessage: 'Не удалось выполнить действие. Попробуйте позже.', cause: error });
}

export function errorDetails(error: AppError) {
  return { errorCode: error.code, component: error.service, stage: error.stage,
    causeCode: technicalCause(error), upstreamStatus: error.upstreamStatus,
    retryable: error.retryable };
}
