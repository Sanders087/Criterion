import { apiRoute, apiDefaults } from '../../../lib/criterion/api-observability';
import { HttpError } from '../../../lib/criterion/app-error';
import { privateMonitoringAuthorized } from '../../../lib/server/monitoring-auth';
import { renderMetrics } from '../../../lib/diagnostic-metrics.mjs';
import { monitoringGauges } from '../../../lib/monitoring-gauges.mjs';

export const dynamic = 'force-dynamic';
export const GET = apiRoute('/api/metrics', async request => {
  if (!privateMonitoringAuthorized(request)) throw new HttpError(403,'Доступ запрещён.');
  return new Response(renderMetrics(monitoringGauges()),{headers:{
    'Content-Type':'text/plain; version=0.0.4; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
  }});
});
export const { POST, PUT, PATCH, DELETE, OPTIONS } = apiDefaults('/api/metrics',['GET']);
