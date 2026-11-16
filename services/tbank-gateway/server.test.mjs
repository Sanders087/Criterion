import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { configuration, createGateway, signature, notificationTransport } from './server.mjs';

const config={secret:'a'.repeat(64),terminal:'1794211361391DEMO',port:8788};
const fixture={TerminalKey:config.terminal,Token:'b'.repeat(64),OrderId:'test',Amount:19900};
test('gateway authenticates the complete body, rejects replays and prevents live payments',async()=>{
  const received=[];
  const server=createGateway(config,async(method,body)=>{received.push({method,body});return{Success:true,ErrorCode:'0'};});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const signed=(payload=fixture,timestamp=String(Math.floor(Date.now()/1000)))=>{
    const body=JSON.stringify(payload),nonce=randomUUID();
    return{method:'POST',body,headers:{'Content-Type':'application/json','X-Criterion-Timestamp':timestamp,'X-Criterion-Nonce':nonce,'X-Criterion-Signature':signature(config.secret,timestamp,nonce,'Init',body)}};
  };
  try{
    assert.equal((await fetch(origin+'/bank/Init',{method:'POST',body:JSON.stringify(fixture)})).status,401);
    const valid=signed();assert.equal((await fetch(origin+'/bank/Init',valid)).status,200);
    assert.equal((await fetch(origin+'/bank/Init',valid)).status,409);
    const altered=signed();altered.body=altered.body.replace('19900','10000');
    assert.equal((await fetch(origin+'/bank/Init',altered)).status,401);
    assert.equal((await fetch(origin+'/bank/Init',signed({...fixture,TerminalKey:'1794211361407'}))).status,400);
    assert.equal((await fetch(origin+'/bank/Init',signed({...fixture,Amount:1}))).status,400);
    assert.equal((await fetch(origin+'/bank/Init',signed({...fixture,Password:'forbidden'}))).status,400);
    assert.equal((await fetch(origin+'/bank/Init',signed(fixture,'1000000000'))).status,401);
    assert.equal((await fetch(origin+'/bank/Confirm',signed())).status,404);
    assert.equal((await fetch(origin+'/bank/Init',{...signed(),body:'x'.repeat(40000)})).status,413);
    const streamed=signed();
    const bytes=new TextEncoder().encode(streamed.body);
    const stream=new ReadableStream({start(controller){controller.enqueue(bytes.slice(0,20));controller.enqueue(bytes.slice(20));controller.close();}});
    assert.equal((await fetch(origin+'/bank/Init',{...streamed,body:stream,duplex:'half'})).status,200);
    assert.deepEqual(received,[{method:'Init',body:JSON.stringify(fixture)},{method:'Init',body:JSON.stringify(fixture)}]);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('gateway returns a safe error on upstream failure',async()=>{
  const server=createGateway(config,async()=>{throw new Error('secret must not appear');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const body=JSON.stringify(fixture),nonce=randomUUID(),timestamp=String(Math.floor(Date.now()/1000));
  try{
    const result=await fetch(`http://127.0.0.1:${server.address().port}/bank/Init`,{method:'POST',body,headers:{'X-Criterion-Timestamp':timestamp,'X-Criterion-Nonce':nonce,'X-Criterion-Signature':signature(config.secret,timestamp,nonce,'Init',body)}});
    assert.equal(result.status,502);assert.equal(await result.text(),'{"error":"Bank connection unavailable"}');
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('configuration refuses non-demo terminals and weak credentials',()=>{
  assert.throws(()=>configuration({CRITERION_GATEWAY_SECRET:'a'.repeat(64),CRITERION_DEMO_TERMINAL:'123456'}));
  assert.throws(()=>configuration({CRITERION_GATEWAY_SECRET:'short',CRITERION_DEMO_TERMINAL:config.terminal}));
});

const liveEnv={CRITERION_MODE:'live',CRITERION_GATEWAY_SECRET:'c'.repeat(64),CRITERION_LIVE_TERMINAL:'123456789',CRITERION_SITE_ORIGIN:'https://criterion-publish-diagnostic-20261113.serenewisteria2.chatgpt.site',CRITERION_SITE_TOKEN:'fixture-access-token-'.repeat(4),PORT:'8789'};
test('live configuration is explicit and pins private Site access',()=>{
  assert.equal(configuration(liveEnv).mode,'live');
  for(const changes of [{CRITERION_MODE:'demo'},{CRITERION_LIVE_TERMINAL:'123456789DEMO'},{CRITERION_SITE_TOKEN:''},{CRITERION_SITE_ORIGIN:'https://evil.test'}])assert.throws(()=>configuration({...liveEnv,...changes}));
});
test('live notifications forward only the original body to the fixed Site and acknowledge only OK',async()=>{
  const cfg=configuration(liveEnv);let reply=new Response('OK');const received=[];
  const send=notificationTransport(cfg,async(url,options)=>{received.push({url,options});return reply;});
  assert.equal(await send('{"bank":"body"}'),200);
  assert.equal(received[0].url,liveEnv.CRITERION_SITE_ORIGIN+'/api/payments/tbank/notification');
  assert.equal(received[0].options.body,'{"bank":"body"}');
  assert.equal(received[0].options.redirect,'manual');
  assert.equal(received[0].options.headers['OAI-Sites-Authorization'],'Bearer '+liveEnv.CRITERION_SITE_TOKEN);
  for(const response of [new Response('redirect',{status:302,headers:{location:'https://evil.test'}}),new Response('<html>Sign in</html>'),new Response('OK\n'),new Response('x'.repeat(100)),new Response('Denied',{status:403})]){reply=response;assert.equal(await send('{}'),502);}
  reply=new Response('Bad order',{status:400});assert.equal(await send('{}'),400);
});
test('live service keeps bank methods authenticated and bounds public notification forwarding',async()=>{
  const cfg=configuration(liveEnv),received=[];let callbackStatus=200;
  const server=createGateway(cfg,async(method,body)=>{received.push({method,body});return{Success:true};},()=>Date.now(),async body=>{received.push({body});return callbackStatus;});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`,payload={...fixture,TerminalKey:cfg.terminal};
  const post=(path,value)=>fetch(origin+path,{method:'POST',body:JSON.stringify(value)});
  try{
    assert.equal((await (await fetch(origin+'/health')).json()).mode,'live');
    assert.equal((await post('/bank/Init',payload)).status,401);
    const body=JSON.stringify(payload),nonce=randomUUID(),timestamp=String(Math.floor(Date.now()/1000));
    assert.equal((await fetch(origin+'/bank/Init',{method:'POST',body,headers:{'X-Criterion-Timestamp':timestamp,'X-Criterion-Nonce':nonce,'X-Criterion-Signature':signature(cfg.secret,timestamp,nonce,'Init',body)}})).status,200);
    const accepted=await post('/notification',payload);assert.equal(accepted.status,200);assert.equal(await accepted.text(),'OK');
    callbackStatus=400;assert.equal((await post('/notification',payload)).status,400);
    const count=received.length;
    for(const invalid of [{...payload,TerminalKey:'other'},{...payload,Token:'bad'},{...payload,Password:'secret'},null,[payload],{...payload,extra:'x'.repeat(17000)}])assert.equal((await post('/notification',invalid)).status,400);
    assert.equal((await post('/notification?url=https://evil.test',payload)).status,404);
    assert.equal((await post('/notification',{...payload,extra:'x'.repeat(40000)})).status,413);
    assert.equal(received.length,count);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
