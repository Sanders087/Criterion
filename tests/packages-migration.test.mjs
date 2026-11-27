import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {openDatabase} from '../db/sqlite.mjs';
test('1.16 upgrades paid/unpaid orders and preserves legacy documents and account data',()=>{
 const dir=mkdtempSync(join(tmpdir(),'criterion-packages-migration-')),old=join(dir,'migrations');mkdirSync(old);
 for(const f of ['0000_wild_adam_destine','0001_sharp_james_howlett','0002_magical_eddie_brock','0003_brown_joseph'])copyFileSync(resolve('drizzle',f+'.sql'),join(old,f+'.sql'));
 const path=join(dir,'db.sqlite');let db=openDatabase(path,{migrationsDir:old});
 try{
  db.prepare('INSERT INTO accounts(id,email,password_hash,salt,recovery_hash,created_at) VALUES(?,?,?,?,?,?)').bind('a','fixture@example.test','hash','salt','recovery',1).run();
  for(const state of ['legacy','paid','unpaid'])db.prepare('INSERT INTO documents(id,owner,title,kind,stage,body,created_at,updated_at,billing_state) VALUES(?,?,?,?,?,?,?,?,?)').bind(state,'a','saved title','services','review','{"unchanged":true}','now','now',state).run();
  for(const state of ['paid','unpaid'])db.prepare('INSERT INTO payment_orders(id,document_id,owner,active_document,amount,terminal_key,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(state,state,'a',state,19900,'fixtureDEMO',state==='paid'?'CONFIRMED':'NEW',1,1).run();
  db.close();db=openDatabase(path);
  assert.equal(db.prepare('SELECT password_hash FROM accounts').first().password_hash,'hash');
  assert.equal(db.prepare("SELECT selected_package FROM documents WHERE id='legacy'").first().selected_package,null);
  for(const state of ['paid','unpaid']){const doc=db.prepare('SELECT * FROM documents WHERE id=?').bind(state).first(),order=db.prepare('SELECT * FROM payment_orders WHERE id=?').bind(state).first();assert.equal(doc.billing_state,state);assert.equal(doc.body,'{"unchanged":true}');assert.equal(doc.selected_package,'contract');assert.equal(order.amount,19900);assert.equal(JSON.parse(order.package_snapshot).signature,false);assert.equal(order.signature_file,null);}
  db.close();db=openDatabase(path);assert.equal(db.prepare('SELECT COUNT(*) n FROM payment_orders').first().n,2);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
