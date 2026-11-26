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
  // Capture the actual Clipboard API write without touching the user's OS clipboard.
  await context.addInitScript(()=>{
    window.__fixtureClipboard = {value:null,denied:false};
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{
      if (window.__fixtureClipboard.denied) throw new DOMException('Denied','NotAllowedError');
      window.__fixtureClipboard.value=value;
    }}});
  });
  const page = await context.newPage();
  const safeId = /^r_[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/;
  async function serverId(response) {
    const id=await response.headerValue('x-request-id');
    assert.match(id,safeId);
    return id;
  }
  async function support(code,id,operationPattern,manual=false) {
    const panel=page.getByRole('alert').filter({hasText:code});
    await panel.waitFor();
    const displayed=await panel.innerText();
    assert.ok(displayed.includes('Код ошибки'));
    await page.evaluate(deny=>{window.__fixtureClipboard.value=null;window.__fixtureClipboard.denied=deny;},manual);
    await panel.getByRole('button',{name:'Скопировать данные ошибки'}).click();
    let content;
    if (manual) {
      const fallback=panel.getByRole('textbox',{name:'Данные ошибки для поддержки'});
      await fallback.waitFor();
      content=await fallback.inputValue();
      assert.equal(await fallback.getAttribute('readonly'),'');
      assert.ok(await fallback.evaluate(node=>node.selectionStart===0&&node.selectionEnd===node.value.length));
    } else {
      await page.waitForFunction(()=>typeof window.__fixtureClipboard.value === 'string');
      content=await page.evaluate(()=>window.__fixtureClipboard.value);
    }
    const lines=content.split('\n');
    assert.equal(lines.shift(),'Код ошибки: '+code);
    if (id) {
      assert.match(id,safeId);assert.ok(displayed.includes(id));
      assert.equal(lines.shift(),'Идентификатор запроса: '+id);
    } else {
      assert.ok(!displayed.includes('Идентификатор запроса'));assert.doesNotMatch(content,/r_[a-f\d-]{36}/);
    }
    const stamp=lines.shift();assert.match(stamp,/^Время: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.ok(Math.abs(Date.parse(stamp.slice('Время: '.length))-Date.now())<120000);
    assert.match(lines.shift(),operationPattern);assert.deepEqual(lines,[]);
    for (const sensitive of [email,password,secret,fragmentToken,bodyId,'http://','/api/'])
      assert.ok(!content.includes(sensitive),'support clipboard must contain allowlisted fields only');
    return content;
  }

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
  const loginLabel=/^Операция: Вход в аккаунт$/u;
  await support('DB_BUSY',headerId,loginLabel);
  authFailure='bad-json';await login.click();
  await support('CLIENT_RESPONSE_INVALID',null,loginLabel);
  authFailure='abort';await login.click();
  await support('CLIENT_NETWORK_ERROR',null,loginLabel,true);
  await context.setOffline(true);
  try {
    assert.equal(await page.evaluate(()=>navigator.onLine),false);
    authFailure='offline';await login.click();await support('CLIENT_OFFLINE',null,loginLabel);
  } finally { await context.setOffline(false); }
  authFailure=null;
  const denied=page.waitForResponse(r=>r.url()===app.origin+'/api/auth'&&r.request().method()==='POST');
  await login.click();const deniedResponse=await denied;assert.equal(deniedResponse.status(),401);
  await support('UNAUTHORIZED',await serverId(deniedResponse),loginLabel);

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
  await page.goto(app.origin+docPath);
  const pay=page.getByRole('button',{name:/199\s*₽/});
  const checkoutReply=page.waitForResponse(r=>r.url()===app.origin+'/api/payments/checkout'&&r.request().method()==='POST');
  await pay.click();
  const checkoutHttp=await checkoutReply;assert.equal(checkoutHttp.status(),502);
  const checkout=app.database().prepare('SELECT status FROM payment_orders WHERE document_id=?').bind(doc.id);
  await support('PAYMENT_CHECK_REQUIRED',await serverId(checkoutHttp),/^Операция: Создание платежа$/u);
  assert.equal(checkout.first().status,'INIT_OUTCOME_UNKNOWN');
  assert.deepEqual(bankMethods,['Init']);assert.equal(await pay.count(),0);
  await page.reload();
  const check=page.getByRole('button',{name:'Проверить оплату',exact:true});
  await check.waitFor();assert.equal(await pay.count(),0);
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
  await page.getByText('CLIENT_NETWORK_ERROR',{exact:true}).waitFor();
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
  await support('UI_EXCEPTION',null,/^Операция: Работа интерфейса$/u);
  await page.unroute('**/api/workspace');
  await page.getByRole('button',{name:'Попробовать снова'}).click();
  await page.getByRole('heading',{name:'Мои документы'}).waitFor();

  // A real auth link form fails gracefully and excludes its fragment from the clipboard.
  await page.goto(app.origin+'/auth#action=reset&token='+fragmentToken);
  const reset=page.getByRole('button',{name:'Сохранить новый пароль'});
  await reset.waitFor();
  await page.getByPlaceholder('Не менее 12 символов').fill(password);
  const failure=page.waitForResponse(r=>r.url()===app.origin+'/api/auth/email'&&r.request().method()==='POST');
  await reset.click();const resetResponse=await failure;
  assert.equal(resetResponse.status(),400);
  await support('BAD_REQUEST',await serverId(resetResponse),/^Операция: Смена пароля$/u);
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
    const alert=dialog.getByRole('alert');
    await alert.getByText('DB_BUSY',{exact:true}).waitFor();
    assert.ok((await alert.innerText()).includes(headerId));
    assert.ok((await dialog.locator('code.recovery-code').textContent())===recovery);
    assert.ok(!(await alert.innerText()).includes(recovery));
    await again.click();
    await dialog.waitFor({state:'hidden'});
    await embedded.getByRole('button',{name:'Открыть настройки аккаунта',exact:true}).waitFor();
  } finally { await embedded.close(); }
  assert.deepEqual(unexpectedEgress,[]);
  console.log('Browser checks passed: HTTP ID and allowlisted clipboard, malformed JSON, offline and missing response, login/logout/register/reset and embedded recovery, uncertain payment after reload, React error boundary and recovery. All data and providers were synthetic.');
} finally {
  try { await browser.close(); } finally { await app?.dispose(); }
}
