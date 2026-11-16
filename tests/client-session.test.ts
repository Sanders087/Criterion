import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ApiError,responseError,signInPath,workspaceReturnPath} from '../lib/criterion/client-session.ts';

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
