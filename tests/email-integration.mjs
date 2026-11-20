import {createTestApp,createFetchMock} from './node-app.mjs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const fetchMock=createFetchMock();fetchMock.disableNetConnect();const sent=[];let failMail=false;
fetchMock.get('https://api.resend.com').intercept({path:'/emails',method:'POST'}).reply(200,async options=>{if(failMail)return '{}';sent.push(await new Response(options.body).json());return JSON.stringify({id:'mock-message-id'})}).persist();
const mf=await createTestApp({bindings:{RESEND_API_KEY:'test-key-not-real',EMAIL_FROM:'Criterion <test@example.com>',AUTH_PUBLIC_URL:'https://criterion.test'},fetchMock});
let checks=0;
async function req(path,body,cookie='',status=200,headers={}){const r=await mf.dispatchFetch('https://criterion.test'+path,{method:body?'POST':'GET',headers:{Origin:'https://criterion.test',...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...headers},body:body?JSON.stringify(body):undefined});const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));checks++;return {data,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
const tokenFrom=mail=>new URLSearchParams(new URL(mail.text.match(/https:\/\/criterion.test\/auth#[^\s]+/)[0]).hash.slice(1)).get('token');
const digest=t=>createHash('sha256').update(t).digest('hex');
try{
 const db=mf.database();
 const endpoint='/api/auth/email',email='verified@example.com',password='Synthetic-Passphrase-2026';
 assert.equal((await req('/api/auth')).data.mailReady,true);
 await req(endpoint,{action:'request-reset',email},'',403,{Origin:'https://evil.test'});
 const reg=await req('/api/auth',{action:'register',email,password});assert.equal(reg.data.verificationSent,true);assert.equal(sent.length,1);assert.deepEqual(sent[0].to,[email]);assert.ok(!sent[0].text.includes(password));const verifyToken=tokenFrom(sent[0]);assert.equal(verifyToken.length,64);
 const tokenRow=await db.prepare('SELECT * FROM email_tokens').first();assert.equal(tokenRow.token_hash,digest(verifyToken));assert.notEqual(tokenRow.token_hash,verifyToken);
 const unverified=await req(endpoint,{action:'request-reset',email});assert.equal(sent.length,1);
 const unknown=await req(endpoint,{action:'request-reset',email:'unknown@example.com'});assert.deepEqual(unknown.data,unverified.data);
 await req(endpoint,{action:'verify',token:verifyToken},'',401);
 const other=await req('/api/auth',{action:'register',email:'other@example.com',password});await req(endpoint,{action:'verify',token:verifyToken},other.cookie,400);
 await req(endpoint,{action:'verify',token:verifyToken},reg.cookie);assert.equal((await req('/api/auth',null,reg.cookie)).data.user.emailVerified,true);
 await req(endpoint,{action:'verify',token:verifyToken},reg.cookie,400);
 const resetRequest=await req(endpoint,{action:'request-reset',email});assert.deepEqual(resetRequest.data,unknown.data);const resetToken=tokenFrom(sent.at(-1));assert.match(sent.at(-1).subject,/Сброс/);
 await req(endpoint,{action:'reset',token:resetToken,password:'short'},'',400);
 const before=await db.prepare('SELECT password_hash FROM accounts WHERE email=?').bind(email).first();
 const race=await Promise.all([mf.dispatchFetch('https://criterion.test'+endpoint,{method:'POST',headers:{Origin:'https://criterion.test','content-type':'application/json'},body:JSON.stringify({action:'reset',token:resetToken,password:'Changed-Passphrase-2026'})}),mf.dispatchFetch('https://criterion.test'+endpoint,{method:'POST',headers:{Origin:'https://criterion.test','content-type':'application/json'},body:JSON.stringify({action:'reset',token:resetToken,password:'Changed-Passphrase-2026'})})]);assert.deepEqual(race.map(r=>r.status).sort(),[200,400]);checks++;
 assert.equal((await req('/api/workspace',null,reg.cookie)).data.user,null);
 const after=await db.prepare('SELECT password_hash FROM accounts WHERE email=?').bind(email).first();assert.notEqual(before.password_hash,after.password_hash);
 await req('/api/auth',{action:'login',email,password},'',401);await req('/api/auth',{action:'login',email,password:'Changed-Passphrase-2026'});
 await req(endpoint,{action:'reset',token:resetToken,password},'',400);
 await db.prepare('DELETE FROM auth_limits').run();
 await req(endpoint,{action:'request-reset',email});const expired=tokenFrom(sent.at(-1));await db.prepare('UPDATE email_tokens SET expires_at=? WHERE token_hash=?').bind(Date.now()-1000,digest(expired)).run();await req(endpoint,{action:'reset',token:expired,password},'',400);
 await req(endpoint,{action:'request-reset',email});const stale=tokenFrom(sent.at(-1));await req('/api/auth',{action:'recover',email,password,recoveryCode:(await race.find(r=>r.status===200).json()).recoveryCode});await req(endpoint,{action:'reset',token:stale,password},'',400);
 failMail=true;
 const beforeFailure=(await db.prepare('SELECT count(*) AS n FROM email_tokens WHERE claim IS NULL AND expires_at>?').bind(Date.now()).first()).n;
 await req(endpoint,{action:'request-reset',email});const afterFailure=(await db.prepare('SELECT count(*) AS n FROM email_tokens WHERE claim IS NULL AND expires_at>?').bind(Date.now()).first()).n;assert.equal(afterFailure,beforeFailure);
 await req(endpoint,{action:'send-verification'},other.cookie,503);
 await req(endpoint,{action:'request-reset',email},'',429);
 // Invalid reset attempts still consume limits. Different links must not share
 // one global bucket, while one link cannot evade its limit by changing IPs.
 await db.prepare('DELETE FROM auth_limits').run();
 for(let i=0;i<21;i++)await req(endpoint,{action:'reset',token:digest('independent-reset-'+i)},'',400,{'cf-connecting-ip':'192.0.2.'+(i+1)});
 const repeatedToken=digest('same-reset-link');
 for(let i=0;i<20;i++)await req(endpoint,{action:'reset',token:repeatedToken},'',400,{'cf-connecting-ip':'198.51.100.'+(i+1)});
 await req(endpoint,{action:'reset',token:repeatedToken},'',429,{'cf-connecting-ip':'198.51.100.21'});
 // The optional email field must not select a different consume bucket.
 await req(endpoint,{action:'reset',token:repeatedToken,email:'unrelated@example.com'},'',429,{'cf-connecting-ip':'198.51.100.22'});
 // Independent token buckets do not relax the existing per-IP ceiling.
 for(let i=0;i<40;i++)await req(endpoint,{action:'reset',token:digest('one-ip-reset-'+i)},'',400,{'cf-connecting-ip':'203.0.113.1'});
 await req(endpoint,{action:'reset',token:digest('one-ip-reset-over-limit')},'',429,{'cf-connecting-ip':'203.0.113.1'});
 console.log(`Email checks passed: ${checks}; mocked provider only. Confirmation, no account enumeration in reset responses, token hashing, expiry, single use/races, session revocation, failed send cleanup, isolated token limits and per-IP limits.`);
}finally{await mf.dispose()}
