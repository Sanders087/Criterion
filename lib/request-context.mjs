// Only server code imports this module. Next can load multiple bundles in the same process.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const key = Symbol.for('criterion.observability.request-context.v1');
const contexts = globalThis[key] ??= new AsyncLocalStorage();
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const requestIdPattern = new RegExp('^r_' + uuid + '$');
const operationIdPattern = new RegExp('^o_' + uuid + '$');
export const validRequestId = id => typeof id === 'string' && id.length === 38 && requestIdPattern.test(id);
export const validOperationId = id => typeof id === 'string' && id.length === 38 && operationIdPattern.test(id);

export function getRequestContext() {
  return contexts.getStore();
}

export function runRequestContext(route, callback) {
  const context = Object.freeze({ requestId: 'r_' + randomUUID(), route });
  return contexts.run(context, callback, context);
}

// Call only after the internal gateway request has been authenticated.
export function runTrustedContext({ requestId, operationId }, callback) {
  return contexts.run(Object.freeze({
    requestId: validRequestId(requestId) ? requestId : 'r_' + randomUUID(),
    ...(validOperationId(operationId) ? { operationId } : {}),
  }), callback);
}

export function runOperation(callback, operationId) {
  const parent = getRequestContext();
  return contexts.run(Object.freeze({
    ...parent,
    operationId: validOperationId(operationId) ? operationId : parent?.operationId ?? 'o_' + randomUUID(),
  }), callback);
}
