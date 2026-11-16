import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {readFile,readdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),wr=createRequire(require.resolve('wrangler/package.json')),{Miniflare,createFetchMock}=wr('miniflare');
const root=fileURLToPath(new URL('../dist/server/',import.meta.url)),files=(await readdir(root,{recursive:true})).filter(f=>/\.m?js$/.test(f));
const fetchMock=createFetchMock();fetchMock.disableNetConnect();
const terminal='fixtureDEMO',password='fixture-not-real',cookie='__Host-criterion_session='+'a'.repeat(64),owner='payment-user';
const receiptEmails=[];const bankPayments=new Map();let initCount=0,checks=0,failAI=false,failInit=false,lostInit=false,unreceivedInit=false,failCheckOrder=false;
const token=data=>createHash('sha256').update(Object.entries({...data,Password:password}).filter(([key,val])=>key!=='Token'&&val!==null&&['string','number','boolean'].includes(typeof val)).sort(([a],[b])=>a.localeCompare(b,'en')).map(([,val])=>String(val)).join('')).digest('hex');
for(const method of ['Init','GetState','CheckOrder','Cancel'])fetchMock.get('https://securepay.tinkoff.ru').intercept({path:'/v2/'+method,method:'POST'}).reply(200,async options=>{
  const data=await new Response(options.body).json();try{assert.equal(data.Token,token(data));assert.equal(data.TerminalKey,terminal)}catch(e){console.error('Mock bank request validation failed:',e);throw e}
  if(method==='Init'){
    receiptEmails.push(data.Receipt.Email);initCount++;assert.equal(data.Amount,19900);assert.equal(data.PayType,'O');assert.equal(data.Receipt.Items[0].Amount,19900);assert.equal(data.DATA.OperationInitiatorType,'0');assert.equal(data.NotificationURL,'https://criterion.test/api/payments/tbank/notification');
    if(failInit)return JSON.stringify({Success:false,ErrorCode:'999'});
    if(unreceivedInit)return 'invalid-json';
    const payment={TerminalKey:terminal,Success:true,ErrorCode:'0',Amount:19900,OrderId:data.OrderId,PaymentId:String(1000+initCount),Status:'NEW',PaymentURL:'https://securepay.tinkoff.ru/new/'+data.OrderId};bankPayments.set(payment.PaymentId,payment);
    return lostInit?'invalid-json':JSON.stringify(payment);
  }
  if(method==='CheckOrder'){if(failCheckOrder)return JSON.stringify({Success:false,ErrorCode:'999'});const payments=[...bankPayments.values()].filter(p=>p.OrderId===data.OrderId);return JSON.stringify(payments.length?{TerminalKey:terminal,Success:true,ErrorCode:'0',OrderId:data.OrderId,Payments:payments}:{Success:false,ErrorCode:'335'})}
  if(method==='Cancel'){const payment=bankPayments.get(data.PaymentId);assert.equal(payment.Status,'NEW');payment.Status='CANCELED';return JSON.stringify(payment)}
  return JSON.stringify(bankPayments.get(data.PaymentId)||{Success:false,ErrorCode:'7'});
}).persist();
fetchMock.get('https://api.openai.com').intercept({path:'/v1/chat/completions',method:'POST'}).reply(200,async options=>{
  if(failAI)return JSON.stringify({error:'fixture failure'});
  const request=await new Response(options.body).json(),input=JSON.parse(request.messages[1].content);
  const value=request.messages[0].content.includes('Режим интервью')?{reply:'Какой срок согласован?',facts:{subject:'Тестовая услуга'},ready:true}:input.expectedSections?{sections:input.expectedSections.map(s=>({...s,content:'PRIVATE-GENERATED-'+s.id})),issues:[{id:'private',severity:'info',title:'Review',detail:'PRIVATE-REVIEW'}]}:{issues:[{id:'check',severity:'info',title:'Проверено',detail:'PRIVATE-REVIEW'}]};
  return JSON.stringify({choices:[{message:{content:JSON.stringify(value)},finish_reason:'stop'}]});
}).persist();
const mf=new Miniflare({modules:['index.js',...files.filter(f=>f!=='index.js')].map(path=>({type:'ESModule',path:root+path})),modulesRoot:root,compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'payments-isolated'},bindings:{OPENAI_API_KEY:'fixture-only',TBANK_ENABLED:'true',TBANK_TERMINAL_KEY:terminal,TBANK_PASSWORD:password,TBANK_PUBLIC_URL:'https://criterion.test',TBANK_RECEIPT_MODE:'bank',TBANK_TAXATION:'usn_income',TBANK_TAX:'none',TBANK_PAYMENT_METHOD:'full_payment',TBANK_PAYMENT_OBJECT:'intellectual_activity'},fetchMock,cf:false});
async function request(path,method='GET',body,status=200,headers={}){
  const response=await mf.dispatchFetch('https://criterion.test'+path,{method,headers:{cookie,Origin:'https://criterion.test',...(body?{'content-type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});
  const data=await response.json();assert.equal(response.status,status,JSON.stringify(data));checks++;return data;
}
async function notification(payment,changes={},expected=200){const body={...payment,...changes};delete body.PaymentURL;body.Token=token(body);const response=await mf.dispatchFetch('https://criterion.test/api/payments/tbank/notification',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,expected,await response.clone().text());if(expected===200)assert.equal(await response.text(),'OK');checks++;}
try{
  const db=await mf.getD1Database('DB');for(const file of (await readdir(new URL('../drizzle/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())for(const sql of (await readFile(new URL('../drizzle/'+file,import.meta.url),'utf8')).split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
  await db.prepare('INSERT INTO accounts(id,email,password_hash,salt,recovery_hash,created_at) VALUES(?,?,?,?,?,?)').bind(owner,'payments@example.test','test','test','test',Date.now()).run();
  await db.prepare('INSERT INTO sessions(token_hash,account_id,expires_at) VALUES(?,?,?)').bind(createHash('sha256').update('a'.repeat(64)).digest('hex'),owner,Date.now()+600000).run();
  let doc=await request('/api/documents','POST',{kind:'services',mode:'ai'},201),path='/api/documents/'+doc.id;
  await request('/api/payments/checkout','POST',{documentId:doc.id},409);
  doc=await request(path,'PATCH',{action:'message',revision:doc.revision,text:'Подготовьте договор на услугу.'});assert.equal(doc.billing.locked,false);
  doc=await request(path,'PATCH',{action:'generate',revision:doc.revision});assert.equal(doc.billing.locked,true);assert.ok(!JSON.stringify(doc).includes('PRIVATE-'));assert.ok(doc.sections.every(s=>s.content===''));
  assert.match((await db.prepare('SELECT body FROM documents WHERE id=?').bind(doc.id).first()).body,/PRIVATE-GENERATED/);
  assert.ok(!JSON.stringify(await request(path)).includes('PRIVATE-'));
  await request(path+'/export?format=docx','GET',undefined,402);await request(path+'/export?format=txt','GET',undefined,402);
  for(const action of ['edit','revise','review','finalize','reopen','restore','save'])await request(path,'PATCH',{action,revision:doc.revision},402);
  await request('/api/payments/checkout','POST',{documentId:doc.id},401,{cookie:''});
  await request('/api/payments/checkout','POST',{documentId:randomUUID()},404);
  await request('/api/payments/checkout','POST',{documentId:doc.id,amount:1},400);
  await request('/api/payments/checkout','POST',{documentId:doc.id},403,{Origin:'https://evil.test'});
  await request('/api/payments/checkout','POST',{documentId:doc.id,receiptEmail:'invalid'},400);
  const before=initCount;
  const attempts=await Promise.all([0,1].map(()=>mf.dispatchFetch('https://criterion.test/api/payments/checkout',{method:'POST',headers:{cookie,Origin:'https://criterion.test','content-type':'application/json'},body:JSON.stringify({documentId:doc.id,receiptEmail:"receipt@example.test"})})));
  assert.ok(attempts.every(r=>[200,409].includes(r.status)));assert.ok(attempts.some(r=>r.status===200));assert.equal(initCount,before+1);assert.equal(receiptEmails.at(-1),"receipt@example.test");const initialized=await attempts.find(r=>r.status===200).json();assert.match(initialized.paymentUrl,/securepay/);checks++;
  const payment=[...bankPayments.values()].find(p=>p.OrderId===initialized.paymentUrl.split('/').at(-1));assert.ok(payment);
  await request(path,'PATCH',{action:'delete',revision:doc.revision},409);
  const bad={...payment,Status:'CONFIRMED',Token:'0'.repeat(64)};assert.equal((await mf.dispatchFetch('https://criterion.test/api/payments/tbank/notification',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(bad)})).status,403);checks++;
  await notification(payment,{Status:'CONFIRMED',Amount:1},400);await notification(payment,{Status:'CONFIRMED',PaymentId:'999999'},400);
  await notification(payment,{Status:'AUTHORIZED'});assert.equal((await request(path)).billing.locked,true);
  payment.Status='CONFIRMED';await notification(payment,{Amount:'19900'});await notification(payment);await notification(payment,{Status:'AUTHORIZED'});
  doc=await request(path);assert.equal(doc.billing.locked,false);assert.equal(doc.billing.aiRemaining,2);assert.match(JSON.stringify(doc),/PRIVATE-GENERATED/);
  assert.equal((await db.prepare("SELECT COUNT(*) count FROM payment_events WHERE order_id=? AND status='CONFIRMED'").bind(payment.OrderId).first()).count,1);
  failAI=true;await request(path,'PATCH',{action:'revise',revision:doc.revision,text:'Уточните срок'},500);failAI=false;doc=await request(path);assert.equal(doc.billing.aiRemaining,2);
  doc=await request(path,'PATCH',{action:'revise',revision:doc.revision,text:'Уточните срок'});assert.equal(doc.billing.aiRemaining,1);
  const rev=doc.revision;const race=await Promise.all([0,1].map(()=>mf.dispatchFetch('https://criterion.test'+path,{method:'PATCH',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({action:'review',revision:rev})})));assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);checks++;
  doc=await request(path);assert.equal(doc.billing.aiRemaining,0);
  await request(path,'PATCH',{action:'revise',revision:doc.revision,text:'Ещё правка'},402);await request(path,'PATCH',{action:'review',revision:doc.revision},402);
  doc=await request(path,'PATCH',{action:'edit',revision:doc.revision,sections:doc.sections});assert.equal(doc.billing.aiRemaining,0);
  assert.equal((await mf.dispatchFetch('https://criterion.test'+path+'/export?format=docx',{headers:{cookie}})).status,200);checks++;
  await notification(payment,{Status:'PARTIAL_REFUNDED',Amount:1000});await notification(payment,{Status:'CONFIRMED'});assert.equal((await request(path)).billing.state,'paid');
  await notification(payment,{Status:'REFUNDED'});await notification(payment,{Status:'CONFIRMED'});doc=await request(path);assert.equal(doc.billing.state,'refunded');assert.equal(doc.billing.aiRemaining,0);assert.ok(!JSON.stringify(doc).includes('PRIVATE-'));
  await request(path+'/export?format=docx','GET',undefined,402);await request('/api/payments/checkout','POST',{documentId:doc.id},409);
  // A lost Init response is reconciled by its immutable OrderId, without another Init.
  let second=await request('/api/documents','POST',{kind:'services',mode:'ai'},201);second=await request('/api/documents/'+second.id,'PATCH',{action:'generate',revision:0});lostInit=true;const beforeLost=initCount;
  await request('/api/payments/checkout','POST',{documentId:second.id},502);lostInit=false;
  const lost=[...bankPayments.values()].at(-1);lost.Status='CONFIRMED';await db.prepare('UPDATE payment_orders SET created_at=?,checked_at=0 WHERE id=?').bind(Date.now()-60000,lost.OrderId).run();
  const recovered=await request('/api/payments/status','POST',{documentId:second.id});assert.equal(recovered.document.billing.state,'paid');assert.equal(initCount,beforeLost+1);checks++;
  // An unshown NEW link is safely cancelled before retry; charged payments are never auto-refunded.
  let third=await request('/api/documents','POST',{kind:'services',mode:'ai'},201);third=await request('/api/documents/'+third.id,'PATCH',{action:'generate',revision:0});lostInit=true;
  await request('/api/payments/checkout','POST',{documentId:third.id},502);lostInit=false;
  const orphan=[...bankPayments.values()].at(-1);await db.prepare('UPDATE payment_orders SET created_at=?,checked_at=0 WHERE id=?').bind(Date.now()-60000,orphan.OrderId).run();
  const canceled=await request('/api/payments/status','POST',{documentId:third.id});assert.equal(canceled.status,'CANCELED');assert.equal(canceled.document.billing.state,'unpaid');
  const retry=await request('/api/payments/checkout','POST',{documentId:third.id});assert.ok(retry.paymentUrl);assert.notEqual(retry.paymentUrl,orphan.PaymentURL);
  // A request that never reached the bank may recover only after an explicit 335,
  // beyond the grace period. A generic failure must not create a second payment.
  let fourth=await request('/api/documents','POST',{kind:'services',mode:'ai'},201);fourth=await request('/api/documents/'+fourth.id,'PATCH',{action:'generate',revision:0});unreceivedInit=true;
  await request('/api/payments/checkout','POST',{documentId:fourth.id},502);unreceivedInit=false;
  const missing=await db.prepare('SELECT id FROM payment_orders WHERE document_id=?').bind(fourth.id).first();
  await db.prepare('UPDATE payment_orders SET created_at=?,checked_at=0 WHERE id=?').bind(Date.now()-60000,missing.id).run();
  const recent=await request('/api/payments/status','POST',{documentId:fourth.id});assert.equal(recent.status,'INITIALIZING');
  await db.prepare('UPDATE payment_orders SET created_at=?,checked_at=0 WHERE id=?').bind(Date.now()-180000,missing.id).run();failCheckOrder=true;
  const beforeRetry=initCount;await request('/api/payments/checkout','POST',{documentId:fourth.id},409);assert.equal(initCount,beforeRetry);failCheckOrder=false;
  await db.prepare('UPDATE payment_orders SET checked_at=0 WHERE id=?').bind(missing.id).run();
  const retried=await request('/api/payments/checkout','POST',{documentId:fourth.id});assert.ok(retried.paymentUrl);assert.equal(initCount,beforeRetry+1);assert.equal(retried.document.billing.state,'unpaid');
  assert.equal((await db.prepare('SELECT status FROM payment_orders WHERE id=?').bind(missing.id).first()).status,'INIT_FAILED');checks++;
  console.log(`Payment integration checks passed: ${checks}. No real bank or AI calls.`);
}finally{await mf.dispose()}
