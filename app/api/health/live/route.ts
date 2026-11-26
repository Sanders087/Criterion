import { apiDefaults, apiRoute } from '../../../../lib/criterion/api-observability';

export const dynamic = 'force-dynamic';
const route = '/api/health/live';
export const GET = apiRoute(route, async () => Response.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } }));
export const { POST, PUT, PATCH, DELETE, OPTIONS } = apiDefaults(route, ['GET']);
