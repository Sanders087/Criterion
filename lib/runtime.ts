import { getDatabase } from '../db/sqlite.mjs';

// Resolve server secrets at request time, never during the client build.
export const env = new Proxy({} as NodeJS.ProcessEnv & { DB: ReturnType<typeof getDatabase> }, {
  get(_target, name) {
    if (name === 'DB') return getDatabase();
    return typeof name === 'string' ? process.env[name] : undefined;
  },
});
