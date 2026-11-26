import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ApiError,responseError,signInPath,workspaceReturnPath,asClientError,supportData,requestJson} from '../lib/criterion/client-session.ts';

const id='7d89c994-18b7-419c-b341-668662fe28b8';
test('sign-in preserves the document and bank return without carrying unrelated data',()=>{
  const path=`/?document=${id}&payment=success`;
  assert.equal(workspaceReturnPath(path+'&untrusted=anything#fragment'),path);
  assert.equal(workspaceReturnPath(`/?document=${id}&payment=fail`),`/?document=${id}&payment=fail`);
  assert.equal(workspaceReturnPath(`/?document=${id}&payment=unknown`),`/?document=${id}`);
  const auth=new URL(signInPath(path),'https://criterion.test');
  assert.equal(auth.pathname,'/auth');
  assert.equal(workspaceReturnPath(auth.searchParams.get('return_to')),path);
});
test('sign-in cannot redirect to an external origin, an API, or the auth page itself',()=>{
  for(const value of [null,'','https://evil.test/','//evil.test/','/\\evil.test/','/%2f%2fevil.test/','javascript:alert(1)','/auth?logout=1','/api/payments/checkout',`/\n/?document=${id}`,'/?document=not-a-document','/?document=%2F%2Fevil.test']){
    assert.equal(workspaceReturnPath(value),'/',String(value));
  }
});
test('expired sessions are recognized even when the response is not JSON',async()=>{
  const expired=await responseError(new Response('<html>Sign in</html>',{status:401}));
  assert.ok(expired instanceof ApiError);assert.equal(expired.status,401);assert.match(expired.message,/Войдите/);
  const unpaid=await responseError(Response.json({error:'Оплатите договор.'},{status:402}));
  assert.equal(unpaid.status,402);assert.equal(unpaid.message,'Оплатите договор.');
  const unavailable=await responseError(new Response('proxy error',{status:502}));
  assert.equal(unavailable.status,502);assert.match(unavailable.message,/Попробуйте/);
});
test('support report uses allowlisted code, authoritative request ID, operation and UTC time only', async()=>{
  const header='r_550e8400-e29b-41d4-a716-446655440000',body='r_fddaf0c6-c5aa-4c71-a2f1-84428dbc231a';
  const markers=['mistake+private@example.test','UPPERCASE_SYNTHETIC_SECRET','https://example.test/private#token'];
  const error=await responseError(Response.json({error:markers.join(' '),code:markers[1],requestId:body},{
    status:502,headers:{'X-Request-ID':header}
  }),'checkout');
  assert.equal(error.code,'HTTP_ERROR');
  assert.equal(error.requestId,header);
  const report=supportData(error);
  assert.deepEqual(report.split('\n'),['Код ошибки: HTTP_ERROR','Идентификатор запроса: '+header,'Время: '+error.occurredAt,'Операция: Создание платежа']);
  assert.match(error.occurredAt,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  for(const marker of [...markers,body]) assert.ok(!report.includes(marker));
  const fallback=await responseError(Response.json({code:'RATE_LIMITED',requestId:body},{status:429,headers:{'X-Request-ID':'invalid'}}),'request_reset');
  assert.equal(fallback.requestId,body);
  assert.equal(fallback.code,'RATE_LIMITED');
  const renderError=asClientError(new Error(markers.join(' ')),'ui');
  assert.equal(renderError.code,'UI_EXCEPTION');
  assert.ok(!supportData(renderError).includes('Идентификатор'));
  assert.ok(!renderError.message.includes(markers[0]));
});

test('request distinguishes offline, transport, rejected HTTP and malformed successful responses', async()=>{
  const previousFetch=globalThis.fetch;
  const navigatorDescriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  const header='r_550e8400-e29b-41d4-a716-446655440000';
  const path='/api/documents/123?secret=fixture';
  try{
    for(const connected of [true,false]){
      Object.defineProperty(globalThis,'navigator',{value:{onLine:connected},configurable:true});
      globalThis.fetch=async()=>{throw new TypeError('fixture-sensitive-network-message')};
      await assert.rejects(requestJson(path,{},'open'),(error:unknown)=>error instanceof ApiError&&
        error.code===(connected?'CLIENT_NETWORK_ERROR':'CLIENT_OFFLINE')&&error.requestId===undefined&&
        !supportData(error).includes(path)&&!error.message.includes('fixture-sensitive'));
    }
    globalThis.fetch=async()=>new Response('<html>proxy</html>',{status:502,headers:{'X-Request-ID':header}});
    await assert.rejects(requestJson(path,{},'open'),(error:unknown)=>error instanceof ApiError&&error.code==='HTTP_ERROR'&&error.requestId===header);
    globalThis.fetch=async()=>new Response('invalid-json',{headers:{'X-Request-ID':header}});
    await assert.rejects(requestJson(path,{},'checkout'),(error:unknown)=>error instanceof ApiError&&error.code==='CLIENT_RESPONSE_INVALID'&&error.requestId===header);
    globalThis.fetch=async()=>Response.json({unexpected:true},{headers:{'X-Request-ID':header}});
    await assert.rejects(requestJson(path,{},'checkout',()=>false),(error:unknown)=>error instanceof ApiError&&error.code==='CLIENT_RESPONSE_INVALID'&&error.requestId===header);
    assert.deepEqual(await requestJson(path,{},'open'),{unexpected:true});
  }finally{
    globalThis.fetch=previousFetch;
    if(navigatorDescriptor)Object.defineProperty(globalThis,'navigator',navigatorDescriptor);else Reflect.deleteProperty(globalThis,'navigator');
  }
});
