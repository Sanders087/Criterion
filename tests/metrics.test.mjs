import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnostic } from '../lib/diagnostics.mjs';
import { renderMetrics } from '../lib/diagnostic-metrics.mjs';
import { runRequestContext } from '../lib/request-context.mjs';

test('metrics survive log filtering and describe bounded error labels and cumulative latency', t => {
  const prior = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'error';
  t.after(()=>{ if (prior) process.env.LOG_LEVEL=prior; else delete process.env.LOG_LEVEL; });
  const secret = 'private-metric-fixture@example.test';
  runRequestContext('/api/workspace',()=>diagnostic('http.request_completed',{method:'GET',httpStatus:200,durationMs:450}));
  runRequestContext(secret,()=>diagnostic('http.request_completed',{httpStatus:200,durationMs:25}));
  diagnostic('payment.transport_failed',{bankMethod:'Init',errorCode:'BANK_TIMEOUT'});
  diagnostic('pii.stage_failed',{stage:secret,errorCode:secret});
  diagnostic('database.operation_failed',{errorCode:'DB_BUSY'});
  const content=renderMetrics({unknown_gauge:null});
  assert.doesNotMatch(content,/private-metric|r_[0-9a-f-]{36}|operationId|requestId/);
  assert.match(content,/http_requests_total\{route="\/api\/workspace",status="200"\} 1/);
  assert.match(content,/http_request_duration_seconds_bucket\{route="\/api\/workspace",le="0.25"\} 0/);
  assert.match(content,/http_request_duration_seconds_bucket\{route="\/api\/workspace",le="0.5"\} 1/);
  assert.match(content,/http_request_duration_seconds_sum\{route="\/api\/workspace"\} 0.45/);
  assert.match(content,/payment_gateway_timeouts_total\{component="bank_direct",operation="Init"\} 1/);
  assert.match(content,/sqlite_busy_total 1/);
  assert.match(content,/unknown_gauge NaN/);
});
