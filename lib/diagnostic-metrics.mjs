// Called with allowlisted diagnostic fields only. Do not accept labels from callers of the HTTP API.
const stateKey = Symbol.for('criterion.monitoring.metrics.v1');
const registry = globalThis[stateKey] ??= new Map();
const counters = ['http_requests_total','application_errors_total','payment_gateway_requests_total',
  'payment_gateway_timeouts_total','mail_send_total','pii_failures_total','ai_requests_total','sqlite_busy_total'];
const bounds = [0.01,0.05,0.1,0.25,0.5,1,2,5,10,30,60,120,Infinity];

function labels(fields) {
  return Object.entries(fields).filter(([,v]) => v !== undefined).map(([k,v]) => k+'="'+v+'"').join(',');
}
function series(metric) {
  if (!registry.has(metric)) registry.set(metric, new Map());
  return registry.get(metric);
}
function inc(name, fields = {}) {
  const values = series(name), key = labels(fields);
  values.set(key,(values.get(key) ?? 0)+1);
}
function histogram(name, fields, seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  const values = series(name), key = labels(fields);
  const cell = values.get(key) ?? { count:0, sum:0, buckets:bounds.map(()=>0) };
  cell.count++;
  cell.sum += seconds;
  bounds.forEach((limit,index)=>{ if (seconds <= limit) cell.buckets[index]++; });
  values.set(key,cell);
}
const mailResults = { 'mail.provider_accepted':'accepted','mail.provider_rejected':'rejected','mail.outcome_unknown':'unknown' };
export function observeMetrics(event,d) {
  if (event === 'http.request_completed' || event === 'http.request_failed') {
    inc('http_requests_total',{route:d.route,status:d.httpStatus});
    histogram('http_request_duration_seconds',{route:d.route},d.durationMs/1000);
    if (d.route === '/api/payments/tbank/notification') histogram('payment_notification_processing_seconds',{},d.durationMs/1000);
    if (d.httpStatus >= 500) inc('application_errors_total',{component:d.component ?? 'criterion',code:d.errorCode ?? 'UNKNOWN'});
  } else if (event === 'operation.failed' || event === 'mail.status_save_failed') {
    inc('application_errors_total',{component:d.component ?? 'mail',code:d.errorCode ?? 'UNKNOWN'});
  } else if (event === 'payment.transport_completed' || event === 'payment.transport_failed') {
    const operation = d.bankMethod, result = event.endsWith('completed') ? 'success' : 'failure';
    const component = d.stage === 'gateway_request' || d.errorCode?.startsWith('GATEWAY_') ? 'gateway'
      : d.stage === 'bank_request' || d.errorCode?.startsWith('BANK_') ? 'bank_direct' : 'unknown';
    inc('payment_gateway_requests_total',{component,operation,result});
    if (d.errorCode?.endsWith('_TIMEOUT')) inc('payment_gateway_timeouts_total',{component,operation});
  } else if (Object.hasOwn(mailResults,event)) {
    inc('mail_send_total',{result:mailResults[event]});
  } else if (event === 'pii.stage_failed') {
    inc('pii_failures_total',{operation:d.stage,code:d.errorCode});
  } else if (event === 'ai.request_completed' || event === 'ai.request_failed') {
    inc('ai_requests_total',{result:event.endsWith('completed') ? 'success' : 'failure'});
  } else if (event === 'database.operation_failed' && ['DB_BUSY','DB_LOCKED'].includes(d.errorCode)) {
    inc('sqlite_busy_total');
  }
}
function sample(name, key, value) {
  return name+(key ? '{'+key+'}' : '')+' '+value;
}
export function renderMetrics(gauges = {}) {
  const lines=[];
  for (const name of counters) {
    lines.push('# TYPE '+name+' counter');
    const values = registry.get(name);
    if (values?.size) for (const [key,value] of values) lines.push(sample(name,key,value));
    else if (name === 'sqlite_busy_total') lines.push(name+' 0');
  }
  for (const name of ['http_request_duration_seconds','payment_notification_processing_seconds']) {
    lines.push('# TYPE '+name+' histogram');
    for (const [key,cell] of registry.get(name) ?? []) {
      bounds.forEach((limit,i)=>lines.push(sample(name+'_bucket',[key,'le="'+(limit === Infinity ? '+Inf' : limit)+'"'].filter(Boolean).join(','),cell.buckets[i])));
      lines.push(sample(name+'_sum',key,cell.sum),sample(name+'_count',key,cell.count));
    }
  }
  for (const [key,value] of Object.entries(gauges)) {
    lines.push('# TYPE '+key+' gauge',sample(key,'',Number.isFinite(value) ? value : 'NaN'));
  }
  return lines.join('\n')+'\n';
}
