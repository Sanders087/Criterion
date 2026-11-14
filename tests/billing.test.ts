import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {bankToken,verifyBankToken,initParameters,checkoutReady,paymentUrl,bankRequest,bankConfig} from '../lib/criterion/tbank.ts';
import {presentContract} from '../lib/criterion/billing.ts';
import {demoContract} from '../lib/criterion/domain.ts';
const env={TBANK_ENABLED:'true',TBANK_TERMINAL_KEY:'fixtureDEMO',TBANK_PASSWORD:'fixture-password',TBANK_PUBLIC_URL:'https://criterion.test',TBANK_RECEIPT_MODE:'bank',TBANK_TAXATION:'usn_income',TBANK_TAX:'none',TBANK_PAYMENT_METHOD:'full_payment',TBANK_PAYMENT_OBJECT:'intellectual_activity'};
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
  assert.equal((data.Receipt as any).Items[0].Amount,19900);assert.equal((data.Receipt as any).Email,'qa@example.test');
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
