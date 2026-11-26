import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ApiError,responseError,signInPath,workspaceReturnPath,asClientError,logClientError,requestJson} from '../lib/criterion/client-session.ts';

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
test('diagnostic-only responses show a plain message and keep recognized metadata', async()=>{
  const requestId = 'r_550e8400-e29b-41d4-a716-446655440000';
  const fallback = 'Сервер не смог выполнить запрос. Попробуйте позже.';
  const cases = [
    {error:'DB_BUSY', code:undefined, expectedCode:'DB_BUSY'},
    {error:' UNAUTHORIZED ', code:'UNAUTHORIZED', expectedCode:'UNAUTHORIZED'},
    {error:'new-opaque-code', code:'new-opaque-code', expectedCode:'HTTP_ERROR'},
    {error:'UNKNOWN_GATEWAY_CODE', code:undefined, expectedCode:'HTTP_ERROR'},
    {error:requestId, code:undefined, expectedCode:'HTTP_ERROR'},
  ];
  for (const {error,code,expectedCode} of cases) {
    const result = await responseError(Response.json({error,code},{status:503}),'login');
    assert.equal(result.message,fallback);
    assert.equal(result.code,expectedCode);
    assert.equal(result.requestId,error===requestId ? requestId : undefined);
  }
  const payment = await responseError(Response.json({error:'GATEWAY_CONNECT_TIMEOUT',requestId},{status:502}),'payment_status');
  assert.equal(payment.message,'Не удалось проверить оплату. Попробуйте чуть позже.');
  assert.equal(payment.code,'GATEWAY_CONNECT_TIMEOUT');
  assert.equal(payment.requestId,requestId);
});

test('client logs record each displayed browser error once using only safe metadata', async t=>{
  const lines: string[] = [];
  t.mock.method(console, 'warn', (line: string)=>lines.push(line));
  const header = 'r_550e8400-e29b-41d4-a716-446655440000';
  const body = 'r_fddaf0c6-c5aa-4c71-a2f1-84428dbc231a';
  const privateText = 'fixture-private@example.test https://fixture.test/?secret=fixture';

  const serverError = await responseError(Response.json({error:'Сервис временно недоступен.',code:'DB_BUSY',requestId:body},{
    status:503,headers:{'X-Request-ID':header}
  }),'checkout');
  assert.equal(serverError.requestId,header);
  logClientError(serverError);
  logClientError(null);
  logClientError(new ApiError(0,'Сохраните правки.','UNSAVED_CHANGES','save'));
  assert.equal(lines.length,0);

  const invalidResponse = new ApiError(200,privateText,'CLIENT_RESPONSE_INVALID','checkout',header);
  logClientError(invalidResponse);
  logClientError(invalidResponse);
  const renderFailure = asClientError(new Error(privateText), 'ui');
  logClientError(renderFailure);
  logClientError(new ApiError(0,privateText,'CLIENT_OFFLINE','open',privateText));
  logClientError(new ApiError(0,privateText,'CLIENT_NETWORK_ERROR','open'));
  assert.deepEqual(lines.map(line=>JSON.parse(line)),[
    {event:'client.error', errorCode:'CLIENT_RESPONSE_INVALID', operation:'checkout', requestId:header},
    {event:'client.error', errorCode:'UI_EXCEPTION', operation:'ui'},
    {event:'client.error', errorCode:'CLIENT_OFFLINE', operation:'open'},
    {event:'client.error', errorCode:'CLIENT_NETWORK_ERROR', operation:'open'},
  ]);
  assert.ok(!renderFailure.message.includes(privateText));
  const fallback=await responseError(Response.json({code:'RATE_LIMITED',requestId:body},{status:429,headers:{'X-Request-ID':'invalid'}}),'request_reset');
  assert.equal(fallback.requestId,body);
  assert.equal(fallback.code,'RATE_LIMITED');
  const unknown=await responseError(Response.json({code:privateText},{status:500}),'open');
  assert.equal(unknown.code,'HTTP_ERROR');
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
        !error.message.includes(path)&&!error.message.includes('fixture-sensitive'));
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
