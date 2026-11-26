import { accessSync, constants, lstatSync, readFileSync, statfsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { diagnostic } from './diagnostics.mjs';

export function readBackupStatus(databasePath) {
  const unknown = {status:'unknown',lastSuccessTimestampSeconds:null};
  try {
    const path = join(dirname(resolve(databasePath)),'backups','status.json');
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.size > 512) return unknown;
    const state = JSON.parse(readFileSync(path,'utf8'));
    if (!['ok','failed'].includes(state?.status)) return unknown;
    const last = state.lastSuccessTimestampSeconds;
    if (!(last === null || Number.isSafeInteger(last) && last > 0)) return unknown;
    if (state.status === 'ok' && last === null) return unknown;
    return {status:state.status,lastSuccessTimestampSeconds:last};
  } catch { return unknown; }
}

function byteSize(path, missing) {
  try { const info = lstatSync(path); return info.isFile() ? info.size : null; }
  catch (error) { return error.code === 'ENOENT' ? missing : null; }
}

export function storageWritable(databasePath) {
  const path = resolve(databasePath);
  try {
    accessSync(dirname(path), constants.W_OK | constants.X_OK);
    accessSync(path, constants.R_OK | constants.W_OK);
    for (const suffix of ['-wal','-shm']) {
      try { accessSync(path+suffix,constants.R_OK | constants.W_OK); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return true;
  } catch (error) {
    return ['EACCES','EPERM','EROFS','ENOENT','ENOTDIR'].includes(error.code) ? false : null;
  }
}

export function collectStorageMetrics(databasePath) {
  const path = resolve(databasePath), directory = dirname(path);
  let freeBytes = null;
  try {
    const volume = statfsSync(directory,{bigint:true});
    const free = volume.bavail * volume.bsize;
    if (free >= 0n && free <= BigInt(Number.MAX_SAFE_INTEGER)) freeBytes = Number(free);
  } catch { /* Missing on some filesystems. */ }
  return {databaseBytes:byteSize(path,null),walBytes:byteSize(path+'-wal',0),freeBytes,writable:storageWritable(path),
    backup:readBackupStatus(path)};
}

export function startStorageMonitor(databasePath) {
  function sample() {
    const {backup,...fields} = collectStorageMetrics(databasePath);
    diagnostic('storage.health',{...fields,backupStatus:backup.status,lastSuccessTimestampSeconds:backup.lastSuccessTimestampSeconds});
  }
  sample();
  const interval = setInterval(sample,300_000);
  interval.unref();
  return interval;
}
