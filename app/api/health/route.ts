import { getDatabase } from '../../../db/sqlite.mjs';
import { apiDefaults, apiRoute } from '../../../lib/criterion/api-observability';
import { AppError } from '../../../lib/criterion/app-error';

export const dynamic = 'force-dynamic';
export const GET = apiRoute('/api/health', async () => {
  try { getDatabase().prepare('SELECT 1 AS ready').first(); }
  catch (cause) { throw new AppError({ status: 503, code: 'DATABASE_ERROR', publicMessage: 'База данных недоступна.',
    service: 'database', stage: 'database', cause }); }
  return Response.json({ status: 'ready' }, { headers: { 'Cache-Control': 'no-store' } });
});

export const { POST, PUT, PATCH, DELETE, OPTIONS } = apiDefaults('/api/health', ['GET']);
