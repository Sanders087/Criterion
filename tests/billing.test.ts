import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {runTrustedContext} from '../lib/request-context.mjs';
import {retryableRead,traceInput} from '../lib/payment-network.mjs';
import {DatabaseSync} from 'node:sqlite';
import {PaymentError,withPaymentOrder,bankToken,verifyBankToken,initParameters,checkoutReady,paymentUrl,bankRequest,bankConfig} from '../lib/criterion/tbank.ts';
import {presentContract} from '../lib/criterion/billing.ts';
import {demoContract} from '../lib/criterion/domain.ts';
const env={TBANK_ENABLED:'true',TBANK_TERMINAL_KEY:'fixtureDEMO',TBANK_PASSWORD:'fixture-password',TBANK_PUBLIC_URL:'https://criterion.test',TBANK_RECEIPT_MODE:'bank',TBANK_TAXATION:'usn_income',TBANK_TAX:'none',TBANK_PAYMENT_METHOD:'full_payment',TBANK_PAYMENT_OBJECT:'intellectual_activity'};
test('Base64 bank password preserves special characters and signs requests with the original value',async(t)=>{
  const password='!fixture-Ж$" with spaces ';
  const encoded=Buffer.from(password,'utf8').toString('base64');
  const config={...env,TBANK_PASSWORD:undefined,TBANK_PASSWORD_BASE64:encoded};
  assert.equal(bankConfig(config).password,password);
  assert.equal(checkoutReady(config),true);
  t.mock.method(globalThis,'fetch',async(_url:string,options:RequestInit)=>{
    const body=String(options.body),data=JSON.parse(body);
    assert.equal(body.includes(password),false);
    assert.equal(body.includes(encoded),false);
    assert.equal(Object.hasOwn(data,'Password'),false);
    assert.equal(await verifyBankToken(data,password),true);
    assert.equal(await verifyBankToken(data,encoded),false);
    return Response.json({Success:true,ErrorCode:'0'});
  });
  assert.deepEqual(await bankRequest(config,'CheckOrder',{OrderId:'fixture'}),{Success:true,ErrorCode:'0'});
});

test('Both password formats preserve exact bytes and an empty optional Base64 setting keeps plaintext compatibility',()=>{
  for(const password of ['!fixture-only',' !fixture-only ','\ufeff!fixture-only']){
    assert.equal(bankConfig({...env,TBANK_PASSWORD:password,TBANK_PASSWORD_BASE64:''}).password,password);
    assert.equal(bankConfig({...env,TBANK_PASSWORD:'',TBANK_PASSWORD_BASE64:Buffer.from(password).toString('base64')}).password,password);
  }
});

test('Invalid or conflicting Base64 bank settings block requests without exposing credentials',async(t)=>{
  const encoded=Buffer.from('!fixture-only').toString('base64');
  const fetch=t.mock.method(globalThis,'fetch',async()=>{throw new Error('Unexpected bank request')});
  const invalid=[...['!',encoded+' ',encoded+'\n','"'+encoded+'"','_w==','/w==','IR==','IQ='].map(value=>({...env,TBANK_PASSWORD:undefined,TBANK_PASSWORD_BASE64:value})),
    {...env,TBANK_PASSWORD_BASE64:encoded}];
  for(const config of invalid){
    assert.equal(checkoutReady(config),false);
    await assert.rejects(()=>bankRequest(config,'CheckOrder',{OrderId:'fixture'}),error=>{
      assert.equal((error as Error & {status:number}).status,503);
      assert.equal((error as Error).message,'Оплата пока недоступна. Настройки банка ещё не завершены.');
      return true;
    });
  }
  assert.equal(fetch.mock.callCount(),0);
});

test('live gateway requires explicit mode and exact notification destination',()=>{
  const live={...env,TBANK_MODE:'live',TBANK_TERMINAL_KEY:'123456789',TBANK_GATEWAY_URL:'https://srv678677.hstgr.cloud/criterion-tbank-live/',TBANK_GATEWAY_SECRET:'d'.repeat(64),TBANK_NOTIFICATION_URL:'https://srv678677.hstgr.cloud/criterion-tbank-live/notification'};
  assert.equal(checkoutReady(live),true);
  assert.equal(initParameters(live,'order','document','receipt@customer.ru').NotificationURL,live.TBANK_NOTIFICATION_URL);
  for(const changes of [{TBANK_MODE:undefined},{TBANK_TERMINAL_KEY:'123456789DEMO'},{TBANK_GATEWAY_URL:'https://srv678677.hstgr.cloud/criterion-tbank/'},{TBANK_NOTIFICATION_URL:'https://evil.test/notification'},{TBANK_NOTIFICATION_URL:live.TBANK_NOTIFICATION_URL+'?next=evil'}])assert.equal(checkoutReady({...live,...changes}),false);
  for(const email of ['test@example.com','test@sub.example.org','qa@example.test','invalid',''])assert.throws(()=>initParameters(live,'order','document',email));
});
test('VPS transport signs the exact body without disclosing the bank password',async(t)=>{
  const gateway={...env,TBANK_GATEWAY_URL:'https://srv678677.hstgr.cloud/criterion-tbank/',TBANK_GATEWAY_SECRET:'c'.repeat(64)};
  t.mock.method(globalThis,'fetch',async(url:string,options:RequestInit)=>{
    assert.equal(url,gateway.TBANK_GATEWAY_URL+'bank/CheckOrder');
    assert.equal(options.redirect,'manual');
    const body=String(options.body),headers=options.headers as Record<string,string>;
    const expected=createHmac('sha256',Buffer.from(gateway.TBANK_GATEWAY_SECRET,'hex')).update(`${headers['X-Criterion-Timestamp']}\n${headers['X-Criterion-Nonce']}\nCheckOrder\n${body}`).digest('hex');
    assert.equal(headers['X-Criterion-Signature'],expected);
    assert.equal(body.includes(env.TBANK_PASSWORD),false);
    assert.equal(await verifyBankToken(JSON.parse(body),env.TBANK_PASSWORD),true);
    return Response.json({Success:true,ErrorCode:'0'});
  });
  assert.deepEqual(await bankRequest(gateway,'CheckOrder',{OrderId:'fixture'}),{Success:true,ErrorCode:'0'});
  for(const changes of [{TBANK_GATEWAY_URL:'https://example.com/criterion-tbank/'},{TBANK_GATEWAY_SECRET:'short'},{TBANK_TERMINAL_KEY:'123456'},{TBANK_API_URL:'https://rest-api-test.tinkoff.ru/v2/'}])assert.throws(()=>bankConfig({...gateway,...changes}));
});
test('payment order error retains the original SQLite failure and order ID after its async scope ends',async()=>{
  const orderId=randomUUID(),db=new DatabaseSync(':memory:');
  let original:unknown;
  try {
    await assert.rejects(withPaymentOrder(orderId,async()=>{
      try { db.prepare('SELECT * FROM missing_fixture_table').get(); }
      catch(cause){ original=cause; throw cause; }
    }),error=>{
      assert.ok(error instanceof Error);
      assert.equal((error as {code?:string}).code,'DATABASE_ERROR');
      assert.equal((error as {operationId?:string}).operationId,'o_'+orderId);
      assert.equal(error.cause,original);
      return true;
    });
    let typed:PaymentError|undefined;
    await assert.rejects(withPaymentOrder(orderId,async()=>{
      typed=new PaymentError(409,'Уточняется статус оплаты.');
      throw typed;
    }),error=>error===typed);
  } finally { db.close(); }
});

test('site forwards authenticated trace headers only to configured gateway',async t=>{
  const context={requestId:'r_'+randomUUID(),operationId:'o_'+randomUUID()};
  const gateway={...env,TBANK_GATEWAY_URL:'https://srv678677.hstgr.cloud/criterion-tbank/',TBANK_GATEWAY_SECRET:'c'.repeat(64)};
  t.mock.method(globalThis,'fetch',async(url:string,options:RequestInit)=>{
    const headers=options.headers as Record<string,string>;
    if (url.startsWith(gateway.TBANK_GATEWAY_URL)) {
      assert.equal(headers['X-Request-ID'],context.requestId);
      assert.equal(headers['X-Operation-ID'],context.operationId);
      assert.equal(headers['X-Criterion-Trace-Signature'],createHmac('sha256',Buffer.from(gateway.TBANK_GATEWAY_SECRET,'hex'))
        .update(traceInput(headers['X-Criterion-Signature'],context.requestId,context.operationId)).digest('hex'));
    } else {
      assert.equal(headers['X-Request-ID'],undefined);
      assert.equal(headers['X-Criterion-Trace-Signature'],undefined);
    }
    return Response.json({Success:true,ErrorCode:'0'});
  });
  await runTrustedContext(context,async()=>{
    await bankRequest(gateway,'CheckOrder',{OrderId:'fixture'});
    await bankRequest(env,'CheckOrder',{OrderId:'fixture'});
  });
});

test('automatic retry advice applies only to read methods and known transient failures',()=>{
  assert.equal(retryableRead('GetState','GATEWAY_HTTP_ERROR',403),false);
  assert.equal(retryableRead('GetState','GATEWAY_HTTP_ERROR',503),true);
  assert.equal(retryableRead('CheckOrder','BANK_TLS_ERROR',undefined),false);
  assert.equal(retryableRead('CheckOrder','BANK_REQUEST_REJECTED',200),false);
  for(const method of ['Init','Cancel'])assert.equal(retryableRead(method,'BANK_TIMEOUT',undefined),false);
});

test('site classifies gateway failures, preserves nested cause and never retries Init', async t => {
  const gateway={...env,TBANK_GATEWAY_URL:'https://srv678677.hstgr.cloud/criterion-tbank/',TBANK_GATEWAY_SECRET:'c'.repeat(64)};
  let reply:Response|undefined, thrown:Error = new Error();
  let calls = 0;
  t.mock.method(globalThis,'fetch',async()=>{ calls++; if (reply) return reply; throw thrown; });
  for (const [low,code] of [
    ['ENOTFOUND','GATEWAY_DNS_ERROR'],['ECONNREFUSED','GATEWAY_CONNECTION_REFUSED'],
    ['UND_ERR_CONNECT_TIMEOUT','GATEWAY_CONNECT_TIMEOUT'],['CERT_HAS_EXPIRED','GATEWAY_TLS_ERROR'],
    ['UND_ERR_HEADERS_TIMEOUT','GATEWAY_TIMEOUT'],['unrecognized','GATEWAY_NETWORK_ERROR'],
  ]) {
    thrown=new TypeError('fixture site error',{cause:Object.assign(new Error('secret-fixture'),{code:low})});
    await assert.rejects(bankRequest(gateway,'Init',{}),error=>{
      assert.equal((error as {code:string}).code,code);
      assert.equal((error as Error).cause,thrown);
      assert.equal((error as {retryable:boolean}).retryable,false);
      return true;
    });
  }
  for (const [response,code] of [
    [new Response('secret',{status:503}), 'GATEWAY_HTTP_ERROR'],
    [new Response('secret',{status:502,headers:{'X-Criterion-Bank-Error':'BANK_TIMEOUT'}}), 'BANK_TIMEOUT'],
    [new Response('secret',{status:502,headers:{'X-Criterion-Bank-Error':'untrusted'}}), 'GATEWAY_HTTP_ERROR'],
    [Response.json({}), 'GATEWAY_RESPONSE_INVALID'],
  ] as const) {
    reply=response;
    await assert.rejects(bankRequest(gateway,'Init',{}),{code,retryable:false});
  }
  const before=calls;
  await assert.rejects(bankRequest(gateway,'Cancel',{},performance.now()-5),{code:'GATEWAY_TIMEOUT',retryable:false});
  assert.equal(calls,before);
});

test('Bank token includes false/zero, excludes nested objects and incoming Token/Password',async()=>{
  const data={TerminalKey:'terminal',Amount:0,Success:false,OrderId:'abc',DATA:{Phone:'private'},Receipt:{Items:[]},Token:'ignored',Password:'attacker'};
  const expected=createHash('sha256').update('0abcsecretfalseterminal').digest('hex');
  assert.equal(await bankToken(data,'secret'),expected);
  assert.equal(await verifyBankToken({...data,Token:expected},'secret'),true);
  assert.equal(await verifyBankToken({...data,Amount:1,Token:expected},'secret'),false);
  assert.equal(await verifyBankToken({...data,Token:''},'secret'),false);
});
test('Price/receipt/redirects are server controlled and checkout fails closed without receipt settings',()=>{
  const data=initParameters(env,'order','document','qa@example.test');assert.equal(data.Amount,19900);assert.equal(data.PayType,'O');
  assert.equal(data.Language,'ru');
  assert.equal(data.SuccessURL,'https://criterion.test/?document=document&payment=success');
  assert.equal(data.FailURL,'https://criterion.test/?document=document&payment=fail');
  assert.equal(data.NotificationURL,'https://criterion.test/api/payments/tbank/notification');
  const receipt=data.Receipt as {Items:Array<{Amount:number}>;Email:string};
  assert.equal(receipt.Items[0].Amount,19900);assert.equal(receipt.Email,'qa@example.test');
  assert.equal(checkoutReady({...env,TBANK_RECEIPT_MODE:undefined}),false);
  assert.equal(checkoutReady({...env,TBANK_PUBLIC_URL:'https://evil.test/?redirect=1'}),false);
  assert.equal(checkoutReady({...env,TBANK_ENABLED:'false'}),false);
  assert.equal(checkoutReady({...env,TBANK_TAXATION:'invented'}),false);
  assert.equal(paymentUrl('https://securepay.tinkoff.ru/new/fixture'),'https://securepay.tinkoff.ru/new/fixture');
  assert.equal(paymentUrl('https://pay.tbank-online.com/fixture'),'https://pay.tbank-online.com/fixture');
  for(const url of ['https://pay.tbank-online.com.evil.test/fixture','http://pay.tbank-online.com/fixture','https://user@pay.tbank-online.com/fixture','https://pay.tbank-online.com:444/fixture'])assert.equal(paymentUrl(url),null);
  for(const url of ['http://securepay.tinkoff.ru/new/fixture','https://securepay.tinkoff.ru.evil.test','https://evil.test','https://user@securepay.tinkoff.ru/'])assert.equal(paymentUrl(url),null);
});
test('Locked presentation has no generated content or version/review copies',()=>{
  const doc=demoContract();doc.sections[0].content='PRIVATE GENERATED TEXT';doc.versions[0].sections[0].content='PRIVATE VERSION';doc.issues=[{id:'x',severity:'high',title:'PRIVATE TITLE',detail:'PRIVATE EXCERPT'}];
  const row={body:JSON.stringify(doc),revision:4,billingState:'unpaid',aiOperationsUsed:0};
  const preview=presentContract(row);assert.equal(preview.billing?.locked,true);assert.ok(!JSON.stringify(preview).includes('PRIVATE'));assert.equal(preview.versions.length,0);
  assert.match(JSON.stringify(presentContract({...row,billingState:'paid'})),/PRIVATE GENERATED TEXT/);
  assert.equal(presentContract({...row,billingState:'paid',aiOperationsUsed:2}).billing?.aiRemaining,0);
  assert.equal(presentContract({...row,billingState:'legacy'}).billing?.aiRemaining,null);
});
