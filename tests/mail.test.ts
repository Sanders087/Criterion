import {AppError} from '../lib/criterion/app-error.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {authMessage,mailReady,sendAuthMail} from '../lib/criterion/mail.ts';
const config={RESEND_API_KEY:'synthetic-test-key',EMAIL_FROM:'Criterion <test@example.com>',AUTH_PUBLIC_URL:'https://criterion.example'};
test('mail requires a configured HTTPS origin, sender and secret',()=>{assert.equal(mailReady(config),true);assert.equal(mailReady({...config,RESEND_API_KEY:''}),false);assert.equal(mailReady({...config,AUTH_PUBLIC_URL:'https://example.com/redirect?to=evil'}),false);assert.equal(mailReady({...config,AUTH_PUBLIC_URL:'http://example.com'}),false)});
for(const [purpose,ttl,context] of [
 ['verify','24 часа','Вы начали регистрацию аккаунта Criterion для recipient@example.com.'],
 ['reset','30 минут','Для вашего аккаунта Criterion (recipient@example.com) запрошен сброс пароля.'],
] as const){
 test(`${purpose} message identifies the account and has one direct expiring fragment link`,()=>{
  const token='a'.repeat(64),m=authMessage(purpose,config.AUTH_PUBLIC_URL,token,'recipient@example.com');
  assert.deepEqual(Object.keys(m).sort(),['subject','text']);
  assert.ok(m.text.startsWith(context));
  assert.match(m.subject,/аккаунта Criterion/);
  const links=m.text.match(/https?:\/\/[^\s]+/g)||[];assert.equal(links.length,1);
  const u=new URL(links[0]);assert.equal(u.origin,config.AUTH_PUBLIC_URL);assert.equal(u.pathname,'/auth');assert.equal(u.search,'');
  assert.deepEqual([...new URLSearchParams(u.hash.slice(1))],[['action',purpose],['token',token]]);
  assert.ok(m.text.includes(`Ссылка действует ${ttl} и используется один раз.`));
  if(purpose==='reset'){
   assert.match(m.subject,/Сброс/);
   assert.match(m.text,/Если вы не запрашивали сброс, просто проигнорируйте письмо — ваш пароль останется прежним\./);
   assert.match(m.text,/После смены пароля прежние сеансы будут завершены\./);
  }else assert.match(m.text,/в том браузере, где вы вошли в Criterion/);
 });
}
test('provider request has fixed recipient, account context, server auth and idempotency',async()=>{let calls=0;const transport=(async(url,init)=>{calls++;assert.equal(url,'https://api.resend.com/emails');const headers=new Headers(init?.headers);assert.equal(headers.get('Authorization'),'Bearer synthetic-test-key');assert.equal(headers.get('Idempotency-Key'),'request-1');const body=JSON.parse(init!.body as string);assert.deepEqual(body.to,['recipient@example.com']);assert.equal(body.from,config.EMAIL_FROM);assert.match(body.text,/Вы начали регистрацию аккаунта Criterion для recipient@example\.com\./);assert.equal('reply_to' in body,false);assert.equal('html' in body,false);assert.equal('headers' in body,false);return Response.json({id:'8b713f1c-acf6-4ef1-943c-beaa32cf5eb6'})}) as typeof fetch;assert.equal(await sendAuthMail(config,'recipient@example.com','verify','b'.repeat(64),'request-1',transport),'8b713f1c-acf6-4ef1-943c-beaa32cf5eb6');assert.equal(calls,1)});

test('optional Reply-To is trimmed when set and omitted when blank',async()=>{
 for(const [value,expected] of [['  support@example.com  ','support@example.com'],['',undefined],['   ',undefined]] as const){
  const mailConfig={...config,EMAIL_REPLY_TO:value};assert.equal(mailReady(mailConfig),true);
  const transport=(async(_url,init)=>{const body=JSON.parse(init!.body as string);assert.equal(body.reply_to,expected);assert.equal('reply_to' in body,expected!==undefined);assert.deepEqual(body.to,['recipient@example.com']);assert.equal(body.from,config.EMAIL_FROM);return Response.json({id:'8b713f1c-acf6-4ef1-943c-beaa32cf5eb6'})}) as typeof fetch;
  await sendAuthMail(mailConfig,'recipient@example.com','reset','b'.repeat(64),'request-1',transport);
 }
});

test('invalid or newline-containing Reply-To disables mail before contacting the provider',async()=>{
 let calls=0;const transport=(async()=>{calls++;return Response.json({id:'unexpected'})}) as typeof fetch;
 for(const value of ['not-an-email','Support <support@example.com>','support@example.com,other@example.com','support@example.com\r\nBcc: other@example.com','support@example.com\n','\r\n','a'.repeat(255)+'@example.com']){
  const mailConfig={...config,EMAIL_REPLY_TO:value};assert.equal(mailReady(mailConfig),false,value);
  await assert.rejects(sendAuthMail(mailConfig,'recipient@example.com','reset','b'.repeat(64),'request-1',transport),error => error instanceof AppError && error.code === 'MAIL_CONFIG_INVALID' && error.stage === 'configuration');
 }
 assert.equal(calls,0);
});
test('provider failure is not reported as delivery success',async()=>{await assert.rejects(sendAuthMail(config,'recipient@example.com','reset','b'.repeat(64),'request-1',(async()=>new Response('denied',{status:403})) as typeof fetch),error => error instanceof AppError && error.stage === 'provider_response' && error.upstreamStatus === 403 && !error.publicMessage.includes('denied'))});

test('uncertain outcomes distinguish lost replies from a definitive rejection',async () => {
 const unknown = [
  async () => { throw new DOMException('fixture-private-response','TimeoutError'); },
  async () => new Response('fixture-private-response',{status:502}),
  async () => Response.json({id:'fixture-private-response'}),
 ];
 for(const transport of unknown){
  await assert.rejects(sendAuthMail(config,'recipient@example.test','reset','b'.repeat(64),'attempt',transport),
   error => error instanceof AppError && error.code==='MAIL_OUTCOME_UNKNOWN' && error.retryable===false);
 }
 await assert.rejects(sendAuthMail(config,'recipient@example.test','reset','b'.repeat(64),'attempt',
  async()=>new Response('fixture-private-response',{status:422})), error=>error instanceof AppError && error.code==='MAIL_PROVIDER_REJECTED');
});
