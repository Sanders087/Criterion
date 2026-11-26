import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { getDatabase } from './sqlite.mjs';
import * as schema from './schema';

export function getDb(operation?:string) {
  const db = getDatabase();
  return drizzle(async (sql, params, method) => db.query(sql, params, method, operation),
    async queries => db.queryBatch(queries), { schema });
}
