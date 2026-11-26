import { apiDefaults, apiRoute } from '../../../../lib/criterion/api-observability';
import { HttpError } from '../../../../lib/criterion/app-error';
import { integrationHealth } from '../../../../lib/server/health';
import { privateMonitoringAuthorized } from '../../../../lib/server/monitoring-auth';

export const dynamic = 'force-dynamic';
const route = '/api/health/integrations';
export const GET = apiRoute(route, async (request: Request) => {
  if (!privateMonitoringAuthorized(request)) throw new HttpError(401, 'Требуется авторизация.');
  return Response.json({ components: await integrationHealth() }, { headers: { 'Cache-Control': 'no-store' } });
});
export const { POST, PUT, PATCH, DELETE, OPTIONS } = apiDefaults(route, ['GET']);
