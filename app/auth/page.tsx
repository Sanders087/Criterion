'use client';
import {useEffect,useState} from 'react';
import {signInPath,workspaceReturnPath} from '../../lib/criterion/client-session';
type Mode='login'|'register'|'recover'|'forgot'|'reset'|'verify';
type AuthState={legacyAvailable:boolean;mailReady:boolean;user:{email:string;emailVerified:boolean}|null};
export default function AuthPage(){
 const [mode,setMode]=useState<Mode>('login');
 const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[code,setCode]=useState(''),[token,setToken]=useState('');
 const [savedCode,setSavedCode]=useState(''),[ack,setAck]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [state,setState]=useState<AuthState|null>(null),[link,setLink]=useState(false),[logout,setLogout]=useState(false),[completed,setCompleted]=useState(false);
 const [returnTo,setReturnTo]=useState('/');
 useEffect(()=>{
  const params=new URLSearchParams(location.search);setLogout(params.has('logout'));setReturnTo(workspaceReturnPath(params.get('return_to')));
  if(params.has('link')){setMode('register');setLink(true)}
  const fragment=new URLSearchParams(location.hash.slice(1));const action=fragment.get('action');
  if(action==='reset'||action==='verify'){setMode(action);setToken(fragment.get('token')||'');history.replaceState(null,'',location.pathname+location.search)}
  fetch('/api/auth',{cache:'no-store'}).then(async r=>await r.json() as AuthState).then(setState).catch(()=>setError('Не удалось проверить аккаунт. Обновите страницу.'));
 },[]);
 async function call(path:string,body:object){
  const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json() as {error?:string;message?:string;recoveryCode?:string;verificationSent?:boolean};
  if(!r.ok)throw new Error(d.error||'Не удалось выполнить запрос.');return d;
 }
 async function sendVerification(){setBusy(true);setError('');try{const d=await call('/api/auth/email',{action:'send-verification'});setNotice(d.message||'Письмо отправлено.')}catch(e){setError(e instanceof Error?e.message:'Ошибка соединения.')}finally{setBusy(false)}}
 async function submit(e:React.FormEvent){
  e.preventDefault();setBusy(true);setError('');setNotice('');
  try{
   const isMail=!logout&&['forgot','reset','verify'].includes(mode);
   const d=await call(isMail?'/api/auth/email':'/api/auth',isMail?{action:mode==='forgot'?'request-reset':mode,email:mode==='forgot'?email:undefined,token:mode==='forgot'?undefined:token,password:mode==='reset'?password:undefined}:{action:logout?'logout':mode,email,password,recoveryCode:code,linkLegacy:mode==='register'&&link});
   if(d.recoveryCode){setSavedCode(d.recoveryCode);setPassword('');setCode('');setNotice(d.verificationSent?'Письмо для подтверждения адреса передано почтовому сервису.':d.message||'');if(mode==='register')setState(s=>s?{...s,user:{email,emailVerified:false}}:s)}
   else if(isMail){setNotice(d.message||'Готово.');if(mode==='verify')setCompleted(true)}
   else location.assign(logout?'/':returnTo);
  }catch(e){setError(e instanceof Error?e.message:'Ошибка соединения.')}finally{setBusy(false)}
 }
 function changeMode(value:Mode){setMode(value);setError('');setNotice('');setPassword('');setCode('');setCompleted(false)}
 const title=logout?'Выйти из аккаунта?':({login:'С возвращением',register:'Создать аккаунт',recover:'Резервный код',forgot:'Забыли пароль?',reset:'Новый пароль',verify:'Подтвердить email'} as const)[mode];
 const description=logout?'Документы останутся в вашем аккаунте.':({login:'Войдите, чтобы продолжить работу с договорами.',register:'Зарегистрируйтесь по email и паролю. Аккаунт ChatGPT не нужен.',recover:'Введите сохранённый код восстановления и новый пароль.',forgot:'Отправим одноразовую ссылку на подтверждённый адрес вашего аккаунта.',reset:'Задайте новый пароль. Все прежние сеансы будут завершены.',verify:'Подтвердите адрес в браузере, где вы вошли в этот аккаунт. Если вход не выполнен, войдите и снова откройте ссылку из письма.'} as const)[mode];
 return <main className="auth-page"><a href="/" className="auth-brand">Criterion<span>Договорённости обретают форму</span></a><section className="auth-card">
 {savedCode?<><div className="eyebrow">РЕЗЕРВНЫЙ ДОСТУП</div><h1>Сохраните резервный код</h1><p>Этот одноразовый код поможет восстановить доступ, если вы потеряете пароль или доступ к почте. Храните его в менеджере паролей и никому не передавайте.</p>{notice&&<p role="status">{notice}</p>}<code className="recovery-code">{savedCode}</code><button type="button" className="button secondary full" onClick={()=>{const a=document.createElement('a');const url=URL.createObjectURL(new Blob([`Criterion\nEmail: ${email}\nКод восстановления: ${savedCode}\nХраните в безопасном месте.\n`],{type:'text/plain'}));a.href=url;a.download='criterion-recovery.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}}>Скачать код</button><p className="muted">{state?.mailReady?'Для восстановления по почте сначала подтвердите email. Резервный код — дополнительный способ доступа.':'Отправка писем ещё не настроена. Пока для восстановления нужен этот код.'}</p>{mode==='register'&&state?.mailReady&&<button className="text-button" disabled={busy} onClick={sendVerification}>Повторить письмо подтверждения</button>}{error&&<p className="auth-error" role="alert">{error}</p>}<label className="auth-check"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>Я сохранил код в безопасном месте</label><button className="button primary full" disabled={!ack} onClick={()=>location.assign(mode==='reset'?signInPath(returnTo):returnTo)}>{mode==='reset'?'Войти с новым паролем':'Перейти к документам'}</button></>:<>
 <div className="eyebrow">ЛИЧНОЕ ПРОСТРАНСТВО</div><h1>{title}</h1><p>{description}</p>{!logout&&returnTo!=='/'&&<p role="status">После входа откроется ваш договор. Статус оплаты сохранён.</p>}
 {!logout&&state?.user&&!state.user.emailVerified&&mode!=='verify'&&state.mailReady&&<div className="auth-verify"><p>Адрес {state.user.email} ещё не подтверждён. Подтвердите его для восстановления пароля по почте.</p><button className="button secondary full" disabled={busy} onClick={sendVerification}>Подтвердить мой email</button></div>}
 {!logout&&['login','register'].includes(mode)&&<div className="auth-tabs"><button className={mode==='login'?'active':''} onClick={()=>changeMode('login')}>Вход</button><button className={mode==='register'?'active':''} onClick={()=>changeMode('register')}>Регистрация</button></div>}
 <form onSubmit={submit}>{!logout&&<>
 {!['reset','verify'].includes(mode)&&<label className="field"><span>Email</span><input autoComplete="email" type="email" required maxLength={254} value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com"/></label>}
 {!['forgot','verify'].includes(mode)&&<label className="field"><span>{mode==='recover'||mode==='reset'?'Новый пароль':'Пароль'}</span><input type="password" autoComplete={mode==='login'?'current-password':'new-password'} required minLength={mode==='login'?1:12} maxLength={256} value={password} onChange={e=>setPassword(e.target.value)} placeholder={mode==='login'?'Ваш пароль':'Не менее 12 символов'}/></label>}
 {mode==='recover'&&<label className="field"><span>Код восстановления</span><input required autoComplete="off" spellCheck={false} value={code} onChange={e=>setCode(e.target.value.trim())}/></label>}
 {mode==='register'&&<><p className="muted">{state?.mailReady?'После регистрации отправим письмо для подтверждения email. Вы также получите резервный код восстановления.':'Почтовая отправка ещё не настроена. После регистрации вы получите резервный код восстановления.'}</p>{state?.legacyAvailable&&<label className="auth-check"><input type="checkbox" checked={link} onChange={e=>setLink(e.target.checked)}/>Привязать документы моего прежнего аккаунта ChatGPT</label>}</>}
 {mode==='forgot'&&!state?.mailReady&&<p>Отправка писем пока недоступна. Используйте резервный код ниже.</p>}
 </>}{error&&<div className="auth-error" role="alert">{error}</div>}{notice&&<p role="status">{notice}</p>}<button className="button primary full" type="submit" disabled={busy||completed||(!logout&&mode==='forgot'&&!state?.mailReady)}>{busy?'Подождите…':logout?'Выйти':({login:'Войти',register:'Создать аккаунт',recover:'Задать новый пароль',forgot:'Отправить ссылку',reset:'Сохранить новый пароль',verify:completed?'Email подтверждён':'Подтвердить email'} as const)[mode]}</button></form>
 {!logout&&<>{mode==='login'?<button className="text-button" onClick={()=>changeMode('forgot')}>Забыли пароль?</button>:!['register','verify'].includes(mode)?<button className="text-button" onClick={()=>changeMode('login')}>Вернуться ко входу</button>:null}{mode==='forgot'&&<button className="text-button" onClick={()=>changeMode('recover')}>Использовать резервный код</button>}
 {['login','register'].includes(mode)&&<details className="auth-legacy"><summary>Уже есть документы в прежнем аккаунте?</summary><p>Один раз подтвердите старый вход, затем создайте email-аккаунт с включённой привязкой документов. Простое совпадение email не переносит документы.</p><a className="button secondary full" href={'/signin-with-chatgpt?return_to='+encodeURIComponent('/auth?link=1&return_to='+encodeURIComponent(returnTo))} target="_top">Подтвердить прежний аккаунт</a></details>}</>}
 </>}<a href="/" className="auth-back">← На главную</a></section><p className="auth-footer">Ваши документы доступны только вашему аккаунту.</p></main>
}
