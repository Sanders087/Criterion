import {createRequire} from 'node:module';
import {readFile,readdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),wr=createRequire(require.resolve('wrangler/package.json')),{Miniflare}=wr('miniflare');
const root=new URL('../dist/server/',import.meta.url).pathname,files=(await readdir(root,{recursive:true})).filter(f=>/\.m?js$/.test(f));
const mf=new Miniflare({modules:['index.js',...files.filter(f=>f!=='index.js')].map(path=>({type:'ESModule',path:root+path})),modulesRoot:root,compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'auth-isolated'},cf:false});
let count=0;
async function req(path,body,cookie='',status=200,headers={}){const r=await mf.dispatchFetch('https://criterion.test'+path,{method:body?'POST':'GET',headers:{Origin:'https://criterion.test',...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...headers},body:body?JSON.stringify(body):undefined});const d=await r.json();assert.equal(r.status,status,JSON.stringify(d));count++;return {data:d,cookie:r.headers.get('set-cookie')?.split(';')[0],headers:r.headers};}
try{
 const db=await mf.getD1Database('DB');for(const file of (await readdir(new URL('../drizzle/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())for(const s of (await readFile(new URL('../drizzle/'+file,import.meta.url),'utf8')).split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean))await db.prepare(s).run();
 const email='qa@example.com',password='Synthetic-Test-Passphrase-2026';
 await req('/api/auth',{action:'register',email,password},'',403,{Origin:'https://evil.test'});
 await req('/api/auth',{action:'register',email,password:'short'},'',400);
 const registration=await req('/api/auth',{action:'register',email:'QA@example.com',password});const cookie=registration.cookie;assert.ok(cookie);assert.match(registration.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Lax/);assert.equal(registration.data.recoveryCode.length,64);
 assert.equal((await req('/api/workspace',null,cookie)).data.user.email,email);
 assert.equal((await req('/api/workspace',null,'')).data.user,null);
 assert.equal((await req('/api/workspace',null,'',200,{'oai-authenticated-user-id':'legacy','oai-authenticated-user-email':email})).data.user,null);
 await req('/api/auth',{action:'register',email,password},'',400);
 await req('/api/auth',{action:'login',email,password:'wrong'},'',401);
 const login=await req('/api/auth',{action:'login',email,password});assert.notEqual(login.cookie,cookie);
 const doc=await req('/api/documents',{kind:'lease',mode:'form',title:'Private auth test'},cookie,201);
 const other=await req('/api/auth',{action:'register',email:'other@example.com',password});await req('/api/documents/'+doc.data.id,null,other.cookie,404);
 const row=await db.prepare('SELECT * FROM accounts WHERE email=?').bind(email).first();assert.notEqual(row.password_hash,password);assert.notEqual(row.recovery_hash,registration.data.recoveryCode);
 await req('/api/auth',{action:'recover',email,password,recoveryCode:'wrong'},'',401);
 const reset=await req('/api/auth',{action:'recover',email,password:'New-Synthetic-Passphrase-2026',recoveryCode:registration.data.recoveryCode});assert.ok(reset.data.recoveryCode);assert.notEqual(reset.data.recoveryCode,registration.data.recoveryCode);
 assert.equal((await req('/api/workspace',null,cookie)).data.user,null);assert.equal((await req('/api/workspace',null,login.cookie)).data.user,null);
 await req('/api/auth',{action:'recover',email,password,recoveryCode:registration.data.recoveryCode},'',401);
 // Clear test-only rate counter before checking credential rotation independently.
 await db.prepare('DELETE FROM auth_limits').run();
 await req('/api/auth',{action:'login',email,password},'',401);
 await req('/api/auth',{action:'logout'},reset.cookie);assert.equal((await req('/api/workspace',null,reset.cookie)).data.user,null);
 await req('/api/auth',{action:'register',email:'missing@example.com',password,linkLegacy:true},'',401);
 const legacyHeaders={'oai-authenticated-user-id':'legacy-owner','oai-authenticated-user-email':'legacy@example.com'};
 await db.prepare('INSERT INTO materials (owner,body,updated_at) VALUES (?,?,?)').bind('legacy-owner',JSON.stringify({prompt:'Legacy private material',template:'',sources:''}),new Date().toISOString()).run();
 const unlinked=await req('/api/auth',{action:'register',email:'legacy@example.com',password});assert.notEqual((await req('/api/workspace',null,unlinked.cookie)).data.materials.prompt,'Legacy private material');
 const linked=await req('/api/auth',{action:'register',email:'linked@example.com',password,linkLegacy:true},'',200,legacyHeaders);assert.equal((await req('/api/workspace',null,linked.cookie)).data.materials.prompt,'Legacy private material');
 await req('/api/auth',{action:'register',email:'second-link@example.com',password,linkLegacy:true},'',409,legacyHeaders);
 for(let i=0;i<10;i++)await req('/api/auth',{action:'login',email:'limit@example.com',password},'',401);await req('/api/auth',{action:'login',email:'limit@example.com',password},'',429);
 console.log(`Auth checks passed: ${count}. Registration, cookies, isolation, CSRF, recovery, revocation, legacy binding and rate limiting.`);
}finally{await mf.dispose()}
