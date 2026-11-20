import { getDatabase } from '../../../db/sqlite.mjs';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    getDatabase().prepare('SELECT 1 AS ready').first();
    return Response.json({ status: 'ready' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ status: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
