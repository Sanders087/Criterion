import { createHash, timingSafeEqual } from 'node:crypto';

export function privateMonitoringAuthorized(request: Request): boolean {
  const expected = process.env.MONITORING_TOKEN || '';
  const provided = request.headers.get('authorization') || '';
  if (!/^[\x21-\x7e]{32,256}$/.test(expected) || !/^Bearer [\x21-\x7e]{32,256}$/.test(provided)) return false;
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(expected), hash(provided.slice(7)));
}
