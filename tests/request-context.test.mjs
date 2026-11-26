import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import {
  getRequestContext, runOperation, runRequestContext, runTrustedContext, validOperationId, validRequestId,
} from '../lib/request-context.mjs';

test('Parallel requests keep independent operations across awaits and restore context after rejection', async () => {
  const requests = await Promise.all(Array.from({ length: 20 }, () =>
    runRequestContext('/api/payments/checkout', async () => {
      const request = getRequestContext();
      assert.ok(validRequestId(request.requestId));
      const operation = await runOperation(async () => {
        const start = getRequestContext();
        await yieldTurn();
        assert.equal(getRequestContext(), start);
        assert.equal(start.requestId, request.requestId);
        assert.ok(validOperationId(start.operationId));
        return start.operationId;
      });
      await assert.rejects(runOperation(async () => {
        await yieldTurn();
        throw new Error('test');
      }, operation));
      assert.equal(getRequestContext(), request);
      return [request.requestId, operation];
    })));
  assert.equal(new Set(requests.flat()).size, 40);
  assert.equal(getRequestContext(), undefined);
});

test('Only complete internal identifiers survive the trusted transport boundary', () => {
  runTrustedContext({ requestId: 'not-an-id', operationId: 'o_bad' }, () => {
    const { requestId, operationId } = getRequestContext();
    assert.ok(validRequestId(requestId));
    assert.equal(operationId, undefined);
    assert.equal(validRequestId(requestId + '\n'), false);
  });
  runRequestContext('/api/payments/status', () => runOperation(() => {
    const { requestId, operationId } = getRequestContext();
    runTrustedContext({ requestId, operationId }, () => {
      assert.deepEqual(getRequestContext(), { requestId, operationId });
    });
  }));
});
