import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/sqlite.mjs';
import { databaseFailure } from '../lib/diagnostic-storage.mjs';
import { collectStorageMetrics, readBackupStatus } from '../lib/storage-monitor.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(),'criterion-storage-ops-'));
  t.after(()=>rmSync(dir,{force:true,recursive:true}));
  return dir;
}

function capture(work) {
  const out = [], info = console.log, err = console.error;
  console.log = console.error = line => out.push(JSON.parse(line));
  try { work(); } finally { console.log = info; console.error = err; }
  return out;
}

test('real lock expiry, read-only and page limit produce distinct safe operation events',t=>{
  const path = join(fixture(t),'test.sqlite');
  const first = openDatabase(path,{migrate:false});
  const second = openDatabase(path,{migrate:false,busyTimeoutMs:50});
  const value = 'private-do-not-log';
  try {
    first.prepare('CREATE TABLE fixture(value TEXT)').run();
    const row = second.prepare('INSERT INTO fixture VALUES (?)').bind(value);
    const logs = capture(()=>{
      first.writeTransaction(()=>assert.throws(()=>second.batch([row],'auth.issue_email_token')));
      second.prepare('PRAGMA query_only=ON').run();
      assert.throws(()=>row.run('auth.create_account'));
      second.prepare('PRAGMA query_only=OFF').run();
      second.prepare('PRAGMA max_page_count=2').first();
      assert.throws(()=>second.prepare('INSERT INTO fixture VALUES (zeroblob(100000))').run('document.create'));
    });
    const errors = logs.filter(e=>e.event==='database.operation_failed');
    assert.deepEqual(errors.map(e=>e.errorCode),['DB_BUSY','DB_READONLY','DB_FULL']);
    assert.equal(errors[0].busyTimeoutMs,50);assert.equal(errors[0].busyTimeoutElapsed,true);
    assert.equal(errors[0].operation,'auth.issue_email_token');assert.equal(errors[0].rolledBack,false);
    assert.ok(errors.every(e=>e.causeCode.startsWith('SQLITE_')&&Number.isInteger(e.sqliteResultCode)));
    assert.ok(!JSON.stringify(logs).includes(value));assert.ok(!JSON.stringify(logs).includes('INSERT INTO'));
  } finally { second.close(); first.close(); }
});

test('rolled back grants never report a committed success or double-count the failing SQL',()=>{
  const db = openDatabase(':memory:',{migrate:false});
  try {
    db.prepare('CREATE TABLE sample(id INTEGER UNIQUE)').run();
    const logs = capture(()=>{
      assert.throws(()=>db.writeTransaction(()=>{
        db.prepare('INSERT INTO sample VALUES (1)').run('payment.grant_access');
        db.prepare('INSERT INTO sample VALUES (1)').run();
      },'payment.apply_notification'));
    });
    assert.equal(logs.length,1);
    assert.equal(logs[0].event,'database.operation_failed');assert.equal(logs[0].errorCode,'DB_TRANSACTION_FAILED');
    assert.equal(logs[0].operation,'payment.apply_notification');assert.equal(logs[0].rolledBack,true);
    assert.equal(db.prepare('SELECT count(*) n FROM sample').first().n,0);
    const ok = capture(()=>db.writeTransaction(()=>{
      db.prepare('INSERT INTO sample VALUES (1)').run('payment.grant_access');
    },'payment.apply_notification'));
    assert.deepEqual(ok.map(e=>e.operation),['payment.grant_access','payment.apply_notification']);
    assert.ok(ok.every(e=>e.event==='database.operation_completed' && e.durationMs>=0));
  } finally { db.close(); }
});

test('an unsupported nested transaction reports only the outer rollback',()=>{
  const db = openDatabase(':memory:',{migrate:false});
  try {
    const logs = capture(()=>assert.throws(()=>db.writeTransaction(()=>{
      db.batch([db.prepare('CREATE TABLE nested_example(n INTEGER)')],'auth.issue_email_token');
    },'auth.create_account')));
    assert.equal(logs.length,1);assert.equal(logs[0].event,'database.operation_failed');
    assert.equal(logs[0].operation,'auth.issue_email_token');assert.equal(logs[0].parentOperation,'auth.create_account');
    assert.equal(logs[0].rolledBack,true);
  } finally { db.close(); }
});

test('classifies wrapped extended SQLite codes without parsing any private text',()=>{
  for (const [number,code] of [[6,'DB_LOCKED'],[3,'DB_PERMISSION_DENIED'],[26,'DB_CORRUPT'],[10,'DB_IO_ERROR'],[517,'DB_BUSY']]) {
    const error=Object.assign(new Error('private fixture'),{code:'ERR_SQLITE_ERROR',errcode:number});
    const result=databaseFailure(new Error('wrapper',{cause:error}));
    assert.equal(result.errorCode,code);assert.equal(result.sqliteResultCode,number);
    assert.ok(!JSON.stringify(result).includes('private'));
  }
});

test('storage sampler reports real WAL, space, write permission and bounded backup metadata', t=>{
  const dir=fixture(t), path=join(dir,'test.sqlite'), db=openDatabase(path,{migrate:false});
  try {
    db.prepare('CREATE TABLE sample(value INTEGER)').run();
    const state=collectStorageMetrics(path);
    assert.ok(state.databaseBytes>0 && state.walBytes>0);assert.ok(state.freeBytes>0);assert.equal(state.writable,true);
    assert.deepEqual(state.backup,{status:'unknown',lastSuccessTimestampSeconds:null});
    mkdirSync(join(dir,'backups'));const status=join(dir,'backups','status.json');
    writeFileSync(status,JSON.stringify({status:'failed',lastSuccessTimestampSeconds:100,unexpected:'private-fixture'}));
    assert.deepEqual(readBackupStatus(path),{status:'failed',lastSuccessTimestampSeconds:100});
    writeFileSync(status,'x'.repeat(1024));assert.equal(readBackupStatus(path).status,'unknown');
  } finally { db.close(); }
});
