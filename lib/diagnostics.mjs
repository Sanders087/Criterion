// Server-side metadata only: never pass request bodies, database rows or secrets here.
import { accessSync, constants, lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const errorCodes = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ENOSPC', 'EROFS',
  'EIO', 'EMFILE', 'ENFILE', 'EBUSY', 'ELOOP', 'ERR_SQLITE_ERROR', 'SQLITE_BUSY',
  'SQLITE_LOCKED', 'SQLITE_READONLY', 'SQLITE_CANTOPEN', 'SQLITE_CORRUPT', 'SQLITE_FULL']);
export function safeErrorCode(error) {
  return errorCodes.has(error?.code) ? error.code : 'UNKNOWN';
}
export function diagnostic(event, fields = {}, level = 'info') {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), service: 'criterion', event, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}
function accessible(path, mode) {
  try { accessSync(path, mode); return true; } catch { return false; }
}
export function fileMetadata(path) {
  try {
    const stat = lstatSync(path);
    return { path, exists: true, type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
      uid: stat.uid, gid: stat.gid, mode: (stat.mode & 0o7777).toString(8).padStart(4, '0'), sizeBytes: stat.size,
      processCanRead: accessible(path, constants.R_OK), processCanWrite: accessible(path, constants.W_OK),
      ...(stat.isDirectory() ? { processCanTraverse: accessible(path, constants.X_OK) } : {}) };
  } catch (error) {
    return { path, exists: error.code === 'ENOENT' ? false : null, errorCode: safeErrorCode(error) };
  }
}
const unescapeMount = value => value.replace(/\\(040|011|012|134)/g, (_, digits) => String.fromCharCode(parseInt(digits, 8)));
export function parseMountInfo(text, filename) {
  const candidates = [];
  for (const line of text.split('\n')) {
    const [left, right] = line.split(' - ');
    if (!right) continue;
    const fields = left.split(' '), extra = right.split(' ');
    if (fields.length < 6 || !fields[4].startsWith('/')) continue;
    const mountPoint = unescapeMount(fields[4]);
    if (!(mountPoint === '/' || filename === mountPoint || filename.startsWith(mountPoint + '/'))) continue;
    const filesystem = /^[a-zA-Z0-9_.-]{1,40}$/.test(extra[0]) ? extra[0] : 'unknown';
    candidates.push({ mountPoint, filesystem, readOnly: fields[5].split(',').includes('ro'),
      separateMount: mountPoint !== '/', persistenceVerified: false });
  }
  candidates.sort((a, b) => b.mountPoint.length - a.mountPoint.length);
  return candidates[0] || { status: 'unknown', persistenceVerified: false };
}
export function storageSnapshot(filename, phase = 'inspection') {
  const databasePath = resolve(filename);
  let mount;
  if (process.platform !== 'linux') mount = { status: 'not_linux', persistenceVerified: false };
  else {
    try { mount = parseMountInfo(readFileSync('/proc/self/mountinfo', 'utf8'), databasePath); }
    catch (error) { mount = { status: 'unknown', errorCode: safeErrorCode(error), persistenceVerified: false }; }
  }
  const snapshot = { phase, databasePath, processUid: process.getuid?.() ?? null, processGid: process.getgid?.() ?? null,
    directory: fileMetadata(dirname(databasePath)), database: fileMetadata(databasePath),
    wal: fileMetadata(databasePath + '-wal'), shm: fileMetadata(databasePath + '-shm'), mount };
  diagnostic('storage.snapshot', snapshot);
  return snapshot;
}
export function integrationConfiguration(env = process.env) {
  diagnostic('integrations.configuration', {
    modelKeyConfigured: Boolean(env.OPENAI_API_KEY),
    mailConfigured: Boolean(env.RESEND_API_KEY && env.EMAIL_FROM),
    paymentsEnabled: env.TBANK_ENABLED === 'true',
    bankCredentialsConfigured: Boolean(env.TBANK_TERMINAL_KEY && (env.TBANK_PASSWORD || env.TBANK_PASSWORD_BASE64)),
    providerAvailability: 'not_checked',
  });
}
