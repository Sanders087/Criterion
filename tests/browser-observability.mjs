import assert from 'node:assert/strict';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createTestApp } from './node-app.mjs';

const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(isAbsolute(moduleName) || moduleName.startsWith('.')
  ? pathToFileURL(resolve(moduleName)).href : moduleName);
const browser = await chromium.launch({headless:true, executablePath:process.env.BROWSER_EXECUTABLE || undefined});
const email = 'browser-observability@example.test', password = 'Synthetic-Observability-Browser-2026';
const secret = 'PRIVATE_BROWSER_FIXTURE', fragmentToken = 'a'.repeat(64);
const headerId = 'r_'+randomUUID(), bodyId = 'r_'+randomUUID();
const bankMethods = [], unexpectedEgress = [];
let app;
try {
  app = await createTestApp({localOrigin:true,bindings:{
    TBANK_ENABLED:'true', TBANK_TERMINAL_KEY:'fixtureDEMO', TBANK_PASSWORD:'synthetic-password',
    TBANK_RECEIPT_MODE:'external', TBANK_PUBLIC_URL:'https://criterion.test', TBANK_API_URL:'https://rest-api-test.tinkoff.ru/v2/',
  },fetchMock:{async dispatch(message) {
    if (message.url === 'https://rest-api-test.tinkoff.ru/v2/Init' && message.method === 'POST') {
      bankMethods.push('Init');
      throw new DOMException('Network fixture','TimeoutError');
    }
    unexpectedEgress.push(new URL(message.url).origin);
    throw new Error('Unexpected external request in isolated browser test.');
  }}});
  const context = await browser.newContext({serviceWorkers:'block'});
  context.setDefaultTimeout(8000);
  const localOnly=route=>{
    if (new URL(route.request().url()).origin === app.origin) return route.continue();
    unexpectedEgress.push(new URL(route.request().url()).origin);
    return route.abort();
  };
  await context.route('**/*',localOnly);
  const page = await context.newPage();
  const authAlert=page.locator('.auth-error[role="alert"]');
  const workspaceAlert=page.locator('.error-box[role="alert"]');
  const safeId = /^r_[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
  async function checkServerError(response,code) {
    const id=await response.headerValue('x-request-id');
    assert.match(id,safeId);
    const body=await response.json();
    assert.equal(body.code,code);
    assert.equal(body.requestId,id);
    // The child process emits this terminal event before returning the HTTP response.
    const line=app.logs().split('\n').find(entry=>entry.startsWith('{')&&
      entry.includes('"event":"http.request_failed"')&&entry.includes('"requestId":"'+id+'"'));
    assert.ok(line,'expected a server failure event for '+id);
    const event=JSON.parse(line);
    assert.equal(event.errorCode,code);
    assert.equal(event.httpStatus,response.status());
  }
  async function plainError(panel,message,{dismissible=false,scope=page}={}) {
    await panel.filter({hasText:message}).waitFor();
    assert.equal((await panel.innerText()).trim(),message);
    assert.equal(await panel.getByRole('button').count(),dismissible?1:0);
    if(dismissible) assert.ok(await panel.getByRole('button',{name:'Закрыть ошибку',exact:true}).isVisible());
    assert.equal(await panel.locator('textarea, details, code').count(),0);
    assert.equal(await scope.getByRole('button',{name:/скопировать.*(?:ошиб|поддержк)/iu}).count(),0);
    assert.equal(await scope.getByRole('textbox',{name:/данные ошибки для поддержки/iu}).count(),0);
  }
  const networkError='Не удалось получить ответ сервера. Проверьте соединение.';

  let authFailure = '503';
  const login = page.getByRole('button',{name:'Войти',exact:true});
  await page.route('**/api/auth',async route=>{
    if (route.request().method() !== 'POST' || !authFailure) return route.fallback();
    if (authFailure === 'abort') return route.abort('failed');
    if (authFailure === 'offline') return route.abort('internetdisconnected');
    if (authFailure === 'bad-json') return route.fulfill({status:200,contentType:'application/json',body:'{'});
    return route.fulfill({status:503,headers:{'Content-Type':'application/json','X-Request-ID':headerId},
      body:JSON.stringify({code:'DB_BUSY',requestId:bodyId,error:'Сервис временно недоступен.',
        stack:secret,form:{email,password},internal:'private browser fixture'})});
  });
  await page.goto(app.origin+'/auth');
  await page.getByLabel('Email',{exact:true}).fill(email);
  await page.getByPlaceholder('Ваш пароль').fill(password);
  await login.click();
  await plainError(authAlert,'Сервис временно недоступен.');
  const browserDiagnostic=page.waitForEvent('console',{
    predicate:entry=>entry.type()==='warning'&&entry.text().includes('"errorCode":"CLIENT_RESPONSE_INVALID"'),
  });
  authFailure='bad-json';await login.click();
  assert.deepEqual(JSON.parse((await browserDiagnostic).text()),{
    event:'client.error',errorCode:'CLIENT_RESPONSE_INVALID',operation:'login',
  });
  await plainError(authAlert,'Не удалось обработать ответ сервера. Обновите страницу и проверьте результат.');
  authFailure='abort';await login.click();
  await plainError(authAlert,networkError);
  await context.setOffline(true);
  try {
    assert.equal(await page.evaluate(()=>navigator.onLine),false);
    authFailure='offline';await login.click();
    await plainError(authAlert,'Нет подключения к сети. Проверьте интернет-соединение.');
  } finally { await context.setOffline(false); }
  authFailure=null;
  const denied=page.waitForResponse(r=>r.url()===app.origin+'/api/auth'&&r.request().method()==='POST');
  await login.click();const deniedResponse=await denied;assert.equal(deniedResponse.status(),401);
  await checkServerError(deniedResponse,'UNAUTHORIZED');
  await plainError(authAlert,'Неверный email или пароль.');

  await page.getByRole('tab',{name:'Регистрация',exact:true}).click();
  await page.getByLabel('Email',{exact:true}).fill(email);
  await page.getByPlaceholder('Не менее 12 символов').fill(password);
  await page.getByRole('button',{name:'Создать аккаунт',exact:true}).click();
  await page.getByRole('heading',{name:'Сохраните резервный код'}).waitFor();
  await page.getByLabel('Я сохранил код в безопасном месте').check();
  await page.getByRole('button',{name:'Перейти к документам',exact:true}).click();
  await page.waitForURL(app.origin+'/');

  // Build a genuine, locked form draft on the temporary standalone server.
  async function change(path, method, data) {
    const result=await page.evaluate(async ({path,method,data})=>{
      const response=await fetch(path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
      return {status:response.status,body:await response.json()};
    },{path,method,data});
    assert.ok(result.status>=200 && result.status<300,'temporary server '+path+' returned '+result.status);
    return result.body;
  }
  await change('/api/materials','PUT',{prompt:'',template:'',sources:''});
  async function lockedDraft() {
    const doc=await change('/api/documents','POST',{kind:'services',mode:'form',title:secret});
    const draft=await change('/api/documents/'+doc.id,'PATCH',{action:'generate',revision:doc.revision});
    assert.equal(draft.billing.locked,true);
    return doc;
  }
  const doc=await lockedDraft(), docPath='/?document='+doc.id;
  const openFailure='Не удалось открыть договор. Попробуйте ещё раз.';
  await page.route(app.origin+'/api/documents/'+doc.id,route=>route.fulfill({status:503,
    headers:{'Content-Type':'application/json','X-Request-ID':headerId},
    body:JSON.stringify({error:openFailure,code:'DB_BUSY',requestId:bodyId,internal:secret}),
  }),{times:1});
  await page.goto(app.origin+docPath);
  await plainError(workspaceAlert,openFailure,{dismissible:true});
  // Retry from the ordinary document list; the one-off failure is gone.
  await page.getByRole('button',{name:new RegExp(secret)}).click();
  await workspaceAlert.waitFor({state:'hidden'});
  const pay=page.getByRole('button',{name:/199\s*₽/});
  const checkoutReply=page.waitForResponse(r=>r.url()===app.origin+'/api/payments/checkout'&&r.request().method()==='POST');
  await pay.click();
  const checkoutHttp=await checkoutReply;assert.equal(checkoutHttp.status(),502);
  const checkout=app.database().prepare('SELECT status FROM payment_orders WHERE document_id=?').bind(doc.id);
  await checkServerError(checkoutHttp,'PAYMENT_CHECK_REQUIRED');
  await plainError(workspaceAlert,'Проверьте состояние платежа перед следующей попыткой.',{dismissible:true});
  assert.equal(checkout.first().status,'INIT_OUTCOME_UNKNOWN');
  assert.deepEqual(bankMethods,['Init']);assert.equal(await pay.count(),0);
  await page.reload();
  const check=page.getByRole('button',{name:'Проверить оплату',exact:true});
  await check.waitFor();assert.equal(await pay.count(),0);
  await page.route('**/api/payments/status',route=>route.fulfill({status:502,
    headers:{'Content-Type':'application/json','X-Request-ID':headerId},
    body:JSON.stringify({code:'GATEWAY_CONNECT_TIMEOUT',requestId:bodyId,error:'GATEWAY_CONNECT_TIMEOUT',internal:secret})
  }),{times:1});
  await check.click();
  await plainError(workspaceAlert,'Не удалось проверить оплату. Попробуйте чуть позже.',{dismissible:true});
  await workspaceAlert.getByRole('button',{name:'Закрыть ошибку',exact:true}).click();
  await workspaceAlert.waitFor({state:'hidden'});
  assert.equal(await pay.count(),0);
  const statusResponse=page.waitForResponse(r=>r.url()===app.origin+'/api/payments/status'&&r.request().method()==='POST');
  await check.click();assert.equal((await statusResponse).status(),200);
  assert.equal(await pay.count(),0);assert.deepEqual(bankMethods,['Init']);

  // Another tab has no checkout sessionStorage marker; the persisted server state alone protects it.
  const fresh=await context.newPage();
  try {
    await fresh.goto(app.origin+docPath);
    await fresh.getByRole('button',{name:'Проверить оплату',exact:true}).waitFor();
    assert.equal(await fresh.getByRole('button',{name:/199\s*₽/}).count(),0);
  } finally { await fresh.close(); }
  assert.equal(app.database().prepare('SELECT count(*) AS n FROM payment_orders WHERE document_id=?').bind(doc.id).first().n,1);

  // A lost client request has no server row yet. Reloading the same tab must preserve
  // uncertainty until the server has had time to finish a possible in-flight checkout.
  const disconnected=await lockedDraft();
  await page.goto(app.origin+'/?document='+disconnected.id);
  await page.route('**/api/payments/checkout', route=>route.abort('failed'));
  await pay.click();await check.waitFor();
  await plainError(workspaceAlert,networkError,{dismissible:true});
  assert.equal(await pay.count(),0);
  await page.reload();await check.waitFor();assert.equal(await pay.count(),0);
  assert.deepEqual(bankMethods,['Init']);
  assert.equal(app.database().prepare('SELECT count(*) AS n FROM payment_orders WHERE document_id=?').bind(disconnected.id).first().n,0);
  await page.unroute('**/api/payments/checkout');

  // The error boundary is reached by an unexpected render shape in the test browser only.
  await page.route('**/api/workspace', route=>route.fulfill({json:{user:{name:'Test',email},ai:false,
    documents:[{id:'fixture',title:{private:secret},kind:'services',stage:'review'}],materials:{}}}));
  await page.goto(app.origin+'/');
  await page.getByRole('heading',{name:'Не удалось отобразить страницу'}).waitFor();
  const renderError='В интерфейсе произошла ошибка. Обновите страницу.';
  await plainError(page.getByRole('alert').filter({hasText:renderError}),renderError);
  await page.unroute('**/api/workspace');
  await page.getByRole('button',{name:'Попробовать снова'}).click();
  await page.getByRole('heading',{name:'Мои документы'}).waitFor();

  // A real auth link form shows only the recovery instructions.
  await page.goto(app.origin+'/auth#action=reset&token='+fragmentToken);
  const reset=page.getByRole('button',{name:'Сохранить новый пароль'});
  await reset.waitFor();
  await page.getByPlaceholder('Не менее 12 символов').fill(password);
  const failure=page.waitForResponse(r=>r.url()===app.origin+'/api/auth/email'&&r.request().method()==='POST');
  await reset.click();const resetResponse=await failure;
  assert.equal(resetResponse.status(),400);
  await checkServerError(resetResponse,'BAD_REQUEST');
  await plainError(authAlert,'Ссылка истекла или уже использована. Запросите новую.');
  await page.goto(app.origin+'/auth?logout=1');
  const logoutResponse=page.waitForResponse(r=>r.url()===app.origin+'/api/auth'&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Выйти',exact:true}).click();
  assert.equal((await logoutResponse).status(),200,'logout should submit only its own fields');
  await page.waitForURL(app.origin+'/');
  await page.goto(app.origin+'/auth');
  await page.getByLabel('Email',{exact:true}).fill(email);
  await page.getByPlaceholder('Ваш пароль').fill(password);
  await login.click();
  await page.waitForURL(app.origin+'/');

  // Embedded registration must retain the one-time code across an unsuccessful workspace refresh.
  const embedded=await browser.newPage({serviceWorkers:'block',viewport:{width:1440,height:900}});
  embedded.setDefaultTimeout(8000);
  try {
    await embedded.route('**/*',localOnly);
    await embedded.goto(app.origin+'/');
    await embedded.getByRole('button',{name:'Вход / Регистрация',exact:true}).first().click();
    const dialog=embedded.getByRole('dialog',{name:'Вход и регистрация'});
    await dialog.getByRole('tab',{name:'Регистрация',exact:true}).click();
    await dialog.getByLabel('Email',{exact:true}).fill('modal-'+email);
    await dialog.getByPlaceholder('Не менее 12 символов').fill(password);
    await dialog.getByRole('button',{name:'Создать аккаунт',exact:true}).click();
    await dialog.getByRole('heading',{name:'Сохраните резервный код'}).waitFor();
    const recovery=await dialog.locator('code.recovery-code').textContent();
    assert.ok(/^[a-f0-9]{64}$/.test(recovery));
    await dialog.getByLabel('Я сохранил код в безопасном месте').check();
    const again=dialog.getByRole('button',{name:'Перейти к документам',exact:true});
    await embedded.route('**/api/workspace',route=>route.fulfill({status:503,
      headers:{'Content-Type':'application/json','X-Request-ID':headerId},body:JSON.stringify({code:'DB_BUSY'})}),{times:1});
    await again.click();
    const alert=dialog.locator('.auth-error[role="alert"]');
    await plainError(alert,'Сервер не смог выполнить запрос. Попробуйте позже.',{scope:dialog});
    assert.equal(await dialog.locator('code.recovery-code').textContent(),recovery);
    await again.click();
    await dialog.waitFor({state:'hidden'});
    await embedded.getByRole('button',{name:'Открыть настройки аккаунта',exact:true}).waitFor();
  } finally { await embedded.close(); }
  assert.deepEqual(unexpectedEgress,[]);
  console.log('Browser checks passed: plain auth, document and payment errors, server log correlation, malformed JSON, offline and missing response, login/logout/register/reset and embedded recovery, payment status timeout and uncertain checkout after reload, React error boundary and recovery. All data and providers were synthetic.');
} finally {
  try { await browser.close(); } finally { await app?.dispose(); }
}
