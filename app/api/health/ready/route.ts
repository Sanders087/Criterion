import { apiDefaults, apiRoute } from '../../../../lib/criterion/api-observability';
import { internalHealth } from '../../../../lib/server/health';

export const dynamic = 'force-dynamic';
const route = '/api/health/ready';
export const GET = apiRoute(route, async () => {
  const { sqlite, piiDetector } = await internalHealth();
  const ready = sqlite.functional && piiDetector.ready;
  return Response.json({ status: ready ? 'ready' : 'unavailable' }, {
    status: ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' },
  });
});
export const { POST, PUT, PATCH, DELETE, OPTIONS } = apiDefaults(route, ['GET']);
