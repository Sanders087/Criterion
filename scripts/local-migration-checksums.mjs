// Local preview migration checks: tolerate only LF/CRLF representation changes.
import { createHash } from 'node:crypto';
const hash = text => createHash('sha256').update(text).digest('hex');
export function localMigrationChecksums(sql) {
  const lf = sql.replace(/\r\n/g, '\n');
  return {
    canonical: hash(lf),
    accepted: new Set([hash(sql), hash(lf), hash(lf.replace(/\n/g, '\r\n'))]),
  };
}
