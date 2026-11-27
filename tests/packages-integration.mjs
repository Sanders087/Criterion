import {createTestApp,createFetchMock} from './node-app.mjs';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {demoContract} from '../lib/criterion/domain.ts';
import {PACKAGES} from '../lib/criterion/packages.ts';
const mock=createFetchMock(),payments=new Map();let count=0,checks=0;
const terminal='fixtureDEMO',password='fixture-only';
const token=d=>createHash('sha256').update(Object.entries({...d,Password:password}).filter(([k,v])=>k!=='Token'&&v!==null&&['string','number','boolean'].includes(typeof v)).sort(([a],[b])=>a.localeCompare(b,'en')).map(([,v])=>String(v)).join('')).digest('hex');
for(const method of ['Init','GetState','Cancel'])mock.get('https://securepay.tinkoff.ru').intercept({path:'/v2/'+method,method:'POST'}).reply(200,async req=>{
 const data=JSON.parse(req.body);assert.equal(data.Token,token(data));
 if(method==='Init'){
  const p=PACKAGES.find(p=>p.amount===data.Amount);assert.ok(p);assert.equal(data.Receipt.Items[0].Amount,p.amount);assert.equal(data.Receipt.Items[0].Name,p.name);
  const payment={TerminalKey:terminal,Success:true,ErrorCode:'0',Amount:p.amount,OrderId:data.OrderId,PaymentId:String(++count),Status:'NEW',PaymentURL:'https://securepay.tinkoff.ru/new/'+data.OrderId};payments.set(payment.PaymentId,payment);return JSON.stringify(payment);
 }
 const p=payments.get(data.PaymentId);assert.ok(p);if(method==='Cancel'){assert.ok(['NEW','FORM_SHOWED'].includes(p.Status));p.Status='CANCELED';}return JSON.stringify(p);
}).persist();
const bindings={TBANK_ENABLED:'true',TBANK_TERMINAL_KEY:terminal,TBANK_PASSWORD:password,TBANK_PUBLIC_URL:'https://criterion.test',TBANK_RECEIPT_MODE:'bank',TBANK_TAXATION:'usn_income',TBANK_TAX:'none',TBANK_PAYMENT_METHOD:'full_payment',TBANK_PAYMENT_OBJECT:'service',CRITERION_SERVICES_ENABLED:'true',CRITERION_ORDER_OPERATORS:'operator',CRITERION_SIGNATURE_TERMS:'Тестовое условие подписи.',CRITERION_VIDEO_TERMS:'Тестовое условие видео.',CRITERION_CONSULTATION_TERMS:'Тестовое условие записи, Europe/Moscow.'};
const app=await createTestApp({bindings,fetchMock:mock});
const db=app.database();
const sessions={client:'a',other:'b',operator:'c'};
const headers=user=>({cookie:'__Host-criterion_session='+sessions[user].repeat(64),Origin:'https://criterion.test'});
async function req(path,method='GET',body,status=200,user='client'){
 const r=await app.dispatchFetch('https://criterion.test'+path,{method,headers:{...headers(user),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));checks++;return data;
}
function seed(){const doc=demoContract();doc.id=randomUUID();doc.revision=0;doc.stage='review';delete doc.billing;db.prepare("INSERT INTO documents(id,owner,title,kind,stage,body,revision,created_at,updated_at,billing_state) VALUES(?,?,?,?,?,?,0,?,?,'unpaid')").bind(doc.id,'client',doc.title,doc.kind,doc.stage,JSON.stringify(doc),doc.createdAt,doc.updatedAt).run();return doc;}
async function choose(doc,id,status=200,user='client'){return req('/api/payments/package','POST',{documentId:doc.id,packageId:id,acknowledge:true},status,user);}
async function checkout(doc,id,status=200){return req('/api/payments/checkout','POST',{documentId:doc.id,packageId:id},status);}
async function notify(p,changes={},status=200){const data={...p,...changes};delete data.PaymentURL;data.Token=token(data);const r=await app.dispatchFetch('https://criterion.test/api/payments/tbank/notification',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});assert.equal(r.status,status,await r.text());checks++;}
async function signature(order,user='operator',status=200,body='%PDF-1.7\nfixture signed document'){const r=await app.dispatchFetch(`https://criterion.test/api/service-orders/${order.id}/signature`,{method:'PUT',headers:{...headers(user),'Content-Type':'application/pdf','X-Order-Version':String(order.version)},body});const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));checks++;return data;}
try{
 for(const [user,char] of Object.entries(sessions)){db.prepare('INSERT INTO accounts(id,email,password_hash,salt,recovery_hash,created_at) VALUES(?,?,?,?,?,?)').bind(user,user+'@example.test','fixture','fixture','fixture',Date.now()).run();db.prepare('INSERT INTO sessions(token_hash,account_id,expires_at) VALUES(?,?,?)').bind(createHash('sha256').update(char.repeat(64)).digest('hex'),user,Date.now()+3600000).run();}
 const doc=seed();
 await req('/api/payments/checkout','POST',{documentId:doc.id},400);await checkout(doc,'video',409);
 await req('/api/payments/package','POST',{documentId:doc.id,packageId:'video'},400);
 await req('/api/payments/package','POST',{documentId:doc.id,packageId:'premium',acknowledge:true},400);
 await choose(doc,'video',404,'other');await req('/api/service-orders', 'GET',undefined,403);
 const saved=await choose(doc,'video');assert.equal(saved.selectedPackage,'video');assert.deepEqual(saved.facts,doc.facts);assert.equal((await req('/api/documents/'+doc.id)).selectedPackage,'video');
 await req('/api/payments/checkout','POST',{documentId:doc.id,packageId:'video',amount:19900},400);
 let started=await checkout(doc,'video');const old=payments.get('1');assert.equal(started.document.order.snapshot.amount,99900);
 await choose(doc,'consultation',409);assert.equal(count,1);old.Status='CANCELED';await notify(old);await choose(doc,'consultation');assert.equal((await req('/api/documents/'+doc.id)).selectedPackage,'consultation');
 started=await checkout(doc,'consultation');assert.equal(count,2);await checkout(doc,'consultation');assert.equal(count,2);
 const paid=payments.get('2');paid.Status='CONFIRMED';await notify(paid,{Amount:19900},400);await notify(paid);await notify(paid);await notify(paid,{Status:'AUTHORIZED'});
 let current=await req('/api/documents/'+doc.id);assert.equal(current.billing.state,'paid');assert.equal(current.order.snapshot.amount,399900);assert.equal(current.order.snapshot.video,false);assert.equal(current.order.complete,false);assert.equal(current.order.snapshot.terms.length,3);
 await choose(doc,'contract',409);assert.equal((await checkout(doc,'consultation')).paymentUrl,null);assert.equal(count,2);
 let order=current.order;await req('/api/service-orders/'+order.id,'GET',undefined,404,'other');await req('/api/service-orders/'+order.id,'PATCH',{action:'video',url:'https://video.example.test/a',version:order.version},403);
 await signature(order,'client',403);await signature(order,'operator',400,'not-pdf');order=await signature(order);assert.equal(order.signatureReady,true);assert.equal(order.complete,false);
 await signature({...order,version:0},'operator',409);
 const signed=await app.dispatchFetch(`https://criterion.test/api/service-orders/${order.id}/signature`,{headers:headers('client')});assert.equal(signed.status,200);assert.match(await signed.text(),/%PDF-/);checks++;
 assert.equal((await app.dispatchFetch(`https://criterion.test/api/service-orders/${order.id}/signature`,{headers:headers('other')})).status,404);checks++;
 assert.equal((await app.dispatchFetch(`https://criterion.test/api/service-orders/${order.id}/document`,{headers:headers('operator')})).status,200);checks++;
 await req('/api/service-orders/'+order.id,'PATCH',{action:'video',url:'https://video.example.test/a',version:order.version},409,'operator');
 const offer={action:'offer',at:new Date(Date.now()+86400000).toISOString(),timezone:'Europe/Moscow',url:'https://meeting.example.test/private',version:order.version};
 await req('/api/service-orders/'+order.id,'PATCH',{...offer,timezone:'bogus'},400,'operator');
 order=await req('/api/service-orders/'+order.id,'PATCH',offer,200,'operator');assert.equal(order.consultationStatus,'offered');assert.equal(order.meetingUrl,null);
 await req('/api/service-orders/'+order.id,'PATCH',{action:'accept',version:order.version},403,'operator');
 order=await req('/api/service-orders/'+order.id,'PATCH',{action:'accept',version:order.version});assert.equal(order.consultationStatus,'scheduled');assert.equal(order.timezone,'Europe/Moscow');assert.ok(order.meetingUrl);
 await req('/api/service-orders/'+order.id,'PATCH',{action:'complete',version:order.version},409,'operator');
 db.prepare('UPDATE payment_orders SET consultation_at=? WHERE id=?').bind(new Date(Date.now()-7200000).toISOString(),order.id).run();
 order=await req('/api/service-orders/'+order.id,'PATCH',{action:'complete',version:order.version},200,'operator');assert.equal(order.complete,true);
 const video=seed();await choose(video,'video');await checkout(video,'video');const vp=payments.get('3');vp.Status='CONFIRMED';await notify(vp);order=(await req('/api/documents/'+video.id)).order;assert.equal(order.complete,false);order=await signature(order);
 await req('/api/service-orders/'+order.id,'PATCH',{action:'video',url:'javascript:alert(1)',version:order.version},400,'operator');
 order=await req('/api/service-orders/'+order.id,'PATCH',{action:'video',url:'https://video.example.test/private',version:order.version},200,'operator');assert.equal(order.complete,true);assert.equal(order.snapshot.consultationMinutes,0);
 assert.equal((await req('/api/documents/'+video.id)).order.videoUrl,order.videoUrl);
 const base=seed();await choose(base,'contract');await checkout(base,'contract');const bp=payments.get('4');assert.equal((await req('/api/documents/'+base.id)).order.paid,false);bp.Status='REJECTED';await notify(bp);assert.equal((await req('/api/documents/'+base.id)).billing.state,'unpaid');await checkout(base,'contract');const bp2=payments.get('5');bp2.Status='CONFIRMED';await notify(bp2);current=await req('/api/documents/'+base.id);assert.equal(current.order.complete,true);assert.equal(current.order.snapshot.amount,19900);
 await notify(vp,{Status:'REFUNDED'});await notify(vp);current=await req('/api/documents/'+video.id);assert.equal(current.order.paid,false);assert.equal(current.order.videoUrl,null);assert.equal(current.order.signatureReady,false);assert.equal(current.order.complete,false);await signature(current.order,'operator',409);
 assert.equal((await app.dispatchFetch(`https://criterion.test/api/service-orders/${current.order.id}/signature`,{headers:headers('client')})).status,404);checks++;
 assert.equal(db.prepare("SELECT COUNT(*) n FROM payment_events WHERE order_id=? AND status='CONFIRMED'").bind(paid.OrderId).first().n,1);
 const list=await req('/api/service-orders','GET',undefined,200,'operator');assert.equal(list.orders.length,2);
 console.log(`Package integration checks passed: ${checks}. All three packages, fulfillment, isolation, selection, cancellation, refunds; no live calls.`);
}finally{await app.dispose();}
// Without approved operating terms, additional sales fail closed on the server.
const closed=await createTestApp({bindings:{...bindings,CRITERION_SERVICES_ENABLED:'false'},fetchMock:mock});
try{const db2=closed.database();db2.prepare('INSERT INTO accounts(id,email,password_hash,salt,recovery_hash,created_at) VALUES(?,?,?,?,?,?)').bind('client','client@example.test','fixture','fixture','fixture',Date.now()).run();db2.prepare('INSERT INTO sessions(token_hash,account_id,expires_at) VALUES(?,?,?)').bind(createHash('sha256').update('a'.repeat(64)).digest('hex'),'client',Date.now()+600000).run();const doc=demoContract();doc.id=randomUUID();db2.prepare("INSERT INTO documents(id,owner,title,kind,stage,body,created_at,updated_at,billing_state) VALUES(?,?,?,?,?,?,?,?,'unpaid')").bind(doc.id,'client',doc.title,doc.kind,'review',JSON.stringify(doc),doc.createdAt,doc.updatedAt).run();const r=await closed.dispatchFetch('https://criterion.test/api/payments/package',{method:'POST',headers:{...headers('client'),'Content-Type':'application/json'},body:JSON.stringify({documentId:doc.id,packageId:'video',acknowledge:true})});assert.equal(r.status,409);console.log('Unconfigured service sales are blocked.');}finally{await closed.dispose();}
