// Server-side metadata only: never pass request bodies, database rows or secrets here.
import { accessSync, constants, lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { diagnosticFields, isTechnicalErrorCode } from './diagnostic-schema.mjs';
import { observeMetrics } from './diagnostic-metrics.mjs';
import { observeIntegrations } from './diagnostic-integrations.mjs';
import { getRequestContext } from './request-context.mjs';

export function safeErrorCode(error) {
  try {
    const code = error?.code;
    return isTechnicalErrorCode(code) ? code : 'UNKNOWN';
  } catch { return 'UNKNOWN'; }
}

const levels = ['debug', 'info', 'warn', 'error'];
function tag(value, fallback) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(value) ? value : fallback;
}

// Keep frequent storage and readiness details searchable even in message-only log views.
function visibleFields(event, detail) {
  if (event === 'storage.snapshot') {
    return { ...detail, mountPoint: detail.mount?.mountPoint, filesystem: detail.mount?.filesystem,
      separateMount: detail.mount?.separateMount, directoryMode: detail.directory?.mode,
      databaseExists: detail.database?.exists, databaseMode: detail.database?.mode,
      processCanRead: detail.database?.processCanRead, processCanWrite: detail.database?.processCanWrite };
  }
  if (event === 'services.health') {
    return { ...detail, piiStatus: detail.pii?.status, siteStatus: detail.site?.status,
      piiHttpStatus: detail.pii?.httpStatus, siteHttpStatus: detail.site?.httpStatus };
  }
  return detail;
}

export function diagnostic(event, fields = {}, level = 'info') {
  try {
    if (!levels.includes(level)) return;
    const detail = diagnosticFields(event, fields, getRequestContext());
    if (!detail) return;
    try { observeMetrics(event,detail); } catch { /* Collection is best effort. */ }
    try { observeIntegrations(event,detail); } catch { /* Providers remain independent of monitoring. */ }
    let minimum = process.env.LOG_LEVEL?.toLowerCase();
    if (minimum === 'debug') {
      const until = Date.parse(process.env.LOG_DEBUG_UNTIL || '');
      if (!Number.isFinite(until) || until <= Date.now() || until - Date.now() > 3600000) minimum = 'info';
    }
    if (levels.indexOf(level) < levels.indexOf(levels.includes(minimum) ? minimum : 'info')) return;
    // Some Amvera views display only the message field. Keep the same searchable marker there.
    const identity = { level, service: tag(process.env.SERVICE_NAME, 'criterion'),
      release: tag(process.env.APP_RELEASE, 'unknown'), instanceId: tag(process.env.INSTANCE_ID, 'unknown') };
    const summary = Object.entries({ ...identity, ...visibleFields(event, detail) }).filter(([,value]) => value !== undefined && typeof value !== 'object')
      .map(([key, value]) => key + '=' + value).join(' ');
    const message = ['Criterion diagnostics v2:', event, summary].filter(Boolean).join(' ');
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...identity, event, message, ...detail });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  } catch {
    // Diagnostics must never fail a request, including when a log sink throws.
  }
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
