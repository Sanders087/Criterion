export interface RequestContext {
  readonly requestId?: string;
  readonly operationId?: string;
  readonly route?: string;
}

export function getRequestContext(): RequestContext | undefined;
export function validRequestId(id: unknown): id is string;
export function validOperationId(id: unknown): id is string;
export function runRequestContext<T>(route: string, callback: (context: RequestContext & { requestId: string; route: string }) => T): T;
export function runOperation<T>(callback: () => T, operationId?: string): T;
export function runTrustedContext<T>(
  ids: { requestId?: unknown; operationId?: unknown },
  callback: () => T,
): T;
