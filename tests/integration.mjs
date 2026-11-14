import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {readFile,readdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const testTokens={'qa-owner':'a'.repeat(64),'other-user':'b'.repeat(64)};
const authHeaders=owner=>owner?{cookie:'__Host-criterion_session='+testTokens[owner]}:{};
const require=createRequire(import.meta.url);const wranglerRequire=createRequire(require.resolve('wrangler/package.json'));const {Miniflare}=wranglerRequire('miniflare');
const root=fileURLToPath(new URL('../dist/server/',import.meta.url));const files=(await readdir(root,{recursive:true})).filter(f=>/\.m?js$/.test(f));const modulePaths=['index.js',...files.filter(f=>f!=='index.js')];
const mf=new Miniflare({modules:modulePaths.map(path=>({type:'ESModule',path:root+path})),modulesRoot:root,compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'criterion-isolated-integration'},cf:false});
let checks=0;let created;
async function request(path,method='GET',body,owner='qa-owner',expected=200,extraHeaders={}){
 const res=await mf.dispatchFetch('https://criterion.test'+path,{method,headers:{...authHeaders(owner),...(body?{'content-type':'application/json'}:{}),...extraHeaders},body:body?JSON.stringify(body):undefined});
 const data=await res.json();assert.equal(res.status,expected,JSON.stringify(data));checks++;return data;
}
try{
 const db=await mf.getD1Database('DB');const sql=await readFile(new URL('../drizzle/0000_wild_adam_destine.sql',import.meta.url),'utf8');for(const stmt of sql.split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean))await db.prepare(stmt).run();
 for(const file of (await readdir(new URL('../drizzle/',import.meta.url))).filter(f=>f.endsWith('.sql')&&!f.startsWith('0000')).sort()){for(const stmt of (await readFile(new URL('../drizzle/'+file,import.meta.url),'utf8')).split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean))await db.prepare(stmt).run();}
 for(const [id,token] of Object.entries(testTokens)){await db.prepare('INSERT INTO accounts (id,email,password_hash,salt,recovery_hash,created_at) VALUES (?,?,?,?,?,?)').bind(id,id+'@example.test','test','test','test',Date.now()).run();await db.prepare('INSERT INTO sessions (token_hash,account_id,expires_at) VALUES (?,?,?)').bind(createHash('sha256').update(token).digest('hex'),id,Date.now()+86400000).run();}
 const defaults=await request('/api/workspace');assert.match(defaults.materials.prompt,/универсальные правила/);assert.equal(JSON.parse(defaults.materials.template).length,9);checks++;
 await request('/api/materials','PUT',{prompt:'',template:'',sources:''});
 await request('/api/documents','POST',{kind:'lease',mode:'form'},null,401);
 await request('/api/documents','POST',{kind:'lease',mode:'form'},'qa-owner',403,{Origin:'https://evil.test'});
 await request('/api/documents','POST',{kind:'lease',mode:'ai'},'qa-owner',503);
 let d=await request('/api/documents','POST',{kind:'lease',mode:'form',title:'Интеграционный тест аренды'},'qa-owner',201);created=d.id;const path='/api/documents/'+d.id;
 await request(path,'GET',undefined,'other-user',404);
 // Existing documents retain their pre-billing access. Paid flows have a separate integration suite.
 await db.prepare("UPDATE documents SET billing_state='legacy' WHERE id=?").bind(d.id).run();
 d=await request(path,'PATCH',{action:'save',revision:d.revision,facts:{partyA:'Тестовый арендодатель',partyB:'Тестовый арендатор',subject:'Офис № 7',price:'50 000 рублей в месяц',payment:'Первого числа каждого месяца',term:'12 месяцев',acceptance:'По акту передачи ключей'}});
 const saved=await request(path);assert.equal(saved.facts.subject,'Офис № 7');checks++;
 await request(path,'PATCH',{action:'save',revision:0,facts:{}},'qa-owner',409);
 d=await request(path,'PATCH',{action:'generate',revision:d.revision});assert.equal(d.sections.length,12);assert.equal(d.stage,'review');assert.match(d.sections.find(s=>s.id==='subject').content,/Офис № 7/);assert.equal(d.versions.length,1);checks++;
 let sections=structuredClone(d.sections);sections.find(s=>s.id==='payment').content='Оплата при получении ключей.';
 d=await request(path,'PATCH',{action:'edit',revision:d.revision,sections});assert.equal(d.versions.length,2);assert.notEqual(d.versions[0].sections.find(s=>s.id==='payment').content,d.sections.find(s=>s.id==='payment').content);checks++;
 const beforeAI=d.revision;await request(path,'PATCH',{action:'revise',revision:d.revision,text:'Изменить оплату'},'qa-owner',500);const failedAI=await request(path);assert.equal(failedAI.revision,beforeAI);checks++;
 d=await request(path,'PATCH',{action:'review',revision:d.revision});
 await request(path,'PATCH',{action:'finalize',revision:d.revision},'qa-owner',400);
 d=await request(path,'PATCH',{action:'finalize',revision:d.revision,acknowledge:true});assert.equal(d.stage,'final');checks++;
 await request(path,'PATCH',{action:'edit',revision:d.revision,sections},'qa-owner',409);
 d=await request(path,'PATCH',{action:'reopen',revision:d.revision});
 d=await request(path,'PATCH',{action:'restore',revision:d.revision,version:1});assert.match(d.sections.find(s=>s.id==='payment').content,/Первого числа/);assert.equal(d.stage,'review');checks++;
 const staleRevision=d.revision;const race=await Promise.all([mf.dispatchFetch('https://criterion.test'+path,{method:'PATCH',headers:{...authHeaders('qa-owner'),'content-type':'application/json'},body:JSON.stringify({action:'review',revision:staleRevision})}),mf.dispatchFetch('https://criterion.test'+path,{method:'PATCH',headers:{...authHeaders('qa-owner'),'content-type':'application/json'},body:JSON.stringify({action:'review',revision:staleRevision})})]);assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);checks++;
 const current=await request(path);
 const exported=await mf.dispatchFetch('https://criterion.test'+path+'/export?format=docx',{headers:{...authHeaders('qa-owner')}});assert.equal(exported.status,200);assert.match(exported.headers.get('Content-Disposition'),/attachment/);const word=new Uint8Array(await exported.arrayBuffer());assert.equal(new DataView(word.buffer).getUint32(0,true),0x04034b50);checks++;await request(path+'/export?format=docx','GET',undefined,'other-user',404);
 const workspace=await request('/api/workspace');assert.ok(workspace.documents.some(v=>v.id===created));checks++;
 await request('/api/materials','PUT',{prompt:'правила',template:'bad json',sources:''},'qa-owner',400);
 await request('/api/materials','PUT',{prompt:'Правила теста',template:'',sources:'Источник теста, редакция 2026'});
 const other=await request('/api/workspace','GET',undefined,'other-user');assert.equal(other.documents.length,0);assert.equal(other.materials.sources,'');checks++;
 await request(path,'PATCH',{action:'delete',revision:current.revision});await request(path,'GET',undefined,'qa-owner',404);
 console.log(`Integration checks passed: ${checks}. Authentication, isolation, persistence, generation, revisions, restore, concurrency and failure rollback verified.`);
}finally{await mf.dispose()}
