import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { diagnostic } from '../lib/diagnostics.mjs';

// Single site instance; the backup helper uses the last verified persisted success
// to decide whether 24 hours have elapsed, including across site restarts.
export function startBackupSchedule(databasePath, env = process.env) {
  if (env.SQLITE_BACKUP_ENABLED !== 'true') return;
  const childEnv = Object.fromEntries(['PATH','SystemRoot','TEMP','TMP','LANG','TZ'].filter(key=>env[key]).map(key=>[key,env[key]]));
  Object.assign(childEnv,{DATABASE_PATH:databasePath,PYTHONDONTWRITEBYTECODE:'1'});
  let active = false;
  function run() {
    if (active) return;
    active = true;
    const child = spawn(env.PII_PYTHON || 'python',[resolve('scripts/backup-db.py'),'--if-due'],{
      env:childEnv,stdio:'ignore',windowsHide:true,timeout:660_000});
    let startFailed = false;
    child.on('error',()=>{ startFailed = true; diagnostic('storage.backup_job_failed',{reason:'spawn_failed'},'error'); });
    child.on('close',(code)=>{
      active = false;
      if (code !== 0 && !startFailed) diagnostic('storage.backup_job_failed',{reason:'helper_failed'},'error');
    });
  }
  run();
  const interval = setInterval(run,3_600_000);
  interval.unref();
  return interval;
}
