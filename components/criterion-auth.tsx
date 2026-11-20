'use client';
import {useEffect,useState,useRef,useId} from 'react';
import {Eye,EyeOff,X} from 'lucide-react';
import './criterion-auth.css';
import {workspaceReturnPath} from '../lib/criterion/client-session';
type Mode='login'|'register'|'recover'|'forgot'|'reset'|'verify';
type AuthState={mailReady:boolean;user:{email:string;emailVerified:boolean}|null};
type AuthProps={embedded?:boolean;onClose?:()=>void;onAuthenticated?:()=>void|Promise<void>;onDismissLockedChange?:(locked:boolean)=>void};
export function AuthScreen({embedded=false,onClose,onAuthenticated,onDismissLockedChange}:AuthProps={}){
 const [showPassword,setShowPassword]=useState(false);
 const tabsId=useId();
 const [mode,setMode]=useState<Mode>('login');
 const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[code,setCode]=useState(''),[token,setToken]=useState('');
 const [savedCode,setSavedCode]=useState(''),[ack,setAck]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [state,setState]=useState<AuthState|null>(null),[logout,setLogout]=useState(false),[completed,setCompleted]=useState(false);
 const [returnTo,setReturnTo]=useState('/');
 const dismissLocked=busy||Boolean(savedCode&&!ack);
 useEffect(()=>{onDismissLockedChange?.(dismissLocked)},[dismissLocked,onDismissLockedChange]);
 useEffect(()=>{
  const params=new URLSearchParams(embedded?'':location.search);setLogout(params.has('logout'));setReturnTo(workspaceReturnPath(params.get('return_to')));
  const fragment=new URLSearchParams(embedded?'':location.hash.slice(1));const action=fragment.get('action');
  if(action==='reset'||action==='verify'){setMode(action);setToken(fragment.get('token')||'');history.replaceState(null,'',location.pathname+location.search)}
  fetch('/api/auth',{cache:'no-store'}).then(async r=>await r.json() as AuthState).then(setState).catch(()=>setError('Не удалось проверить аккаунт. Обновите страницу.'));
 },[embedded]);
 async function finish(){if(embedded&&onAuthenticated)await onAuthenticated();else location.assign(returnTo)}
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
   const d=await call(isMail?'/api/auth/email':'/api/auth',isMail?{action:mode==='forgot'?'request-reset':mode,email:mode==='forgot'?email:undefined,token:mode==='forgot'?undefined:token,password:mode==='reset'?password:undefined}:{action:logout?'logout':mode,email,password,recoveryCode:code});
   if(d.recoveryCode){setSavedCode(d.recoveryCode);setPassword('');setCode('');setNotice(d.verificationSent?'Письмо для подтверждения адреса передано почтовому сервису.':d.message||'');if(mode==='register')setState(s=>s?{...s,user:{email,emailVerified:false}}:s)}
   else if(isMail){setNotice(d.message||'Готово.');if(mode==='verify')setCompleted(true)}
   else if(logout)location.assign('/');else await finish();
  }catch(e){setError(e instanceof Error?e.message:'Ошибка соединения.')}finally{setBusy(false)}
 }
 function changeMode(value:Mode){setShowPassword(false);setMode(value);setError('');setNotice('');setPassword('');setCode('');setCompleted(false)}
 const title=logout?'Выйти из аккаунта?':({login:'С возвращением',register:'Создать аккаунт',recover:'Резервный код',forgot:'Забыли пароль?',reset:'Новый пароль',verify:'Подтвердить email'} as const)[mode];
 const description=logout?'Документы останутся в вашем аккаунте.':({login:'Войдите, чтобы продолжить работу с договорами.',register:'Зарегистрируйтесь по email и паролю.',recover:'Введите сохранённый код восстановления и новый пароль.',forgot:'Отправим одноразовую ссылку на подтверждённый адрес вашего аккаунта.',reset:'Задайте новый пароль. Все прежние сеансы будут завершены.',verify:'Подтвердите адрес в браузере, где вы вошли в этот аккаунт. Если вход не выполнен, войдите и снова откройте ссылку из письма.'} as const)[mode];
 return <div className={embedded?"auth-embedded":"auth-page"}>{!embedded&&<a href="/" className="auth-brand">Criterion<span>Договорённости обретают форму</span></a>}<section className="auth-card">
 {embedded&&<button type="button" className="icon-button auth-dialog-close" aria-label="Закрыть вход и регистрацию" disabled={dismissLocked} onClick={onClose}><X size={20}/></button>}
 {savedCode?<><div className="eyebrow">РЕЗЕРВНЫЙ ДОСТУП</div><h1>Сохраните резервный код</h1><p>Этот одноразовый код поможет восстановить доступ, если вы потеряете пароль или доступ к почте. Храните его в менеджере паролей и никому не передавайте.</p>{notice&&<p role="status">{notice}</p>}<code className="recovery-code">{savedCode}</code><button type="button" className="button secondary full" onClick={()=>{const a=document.createElement('a');const url=URL.createObjectURL(new Blob([`Criterion\nEmail: ${email}\nКод восстановления: ${savedCode}\nХраните в безопасном месте.\n`],{type:'text/plain'}));a.href=url;a.download='criterion-recovery.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}}>Скачать код</button><p className="muted">{state?.mailReady?'Для восстановления по почте сначала подтвердите email. Резервный код — дополнительный способ доступа.':'Отправка писем ещё не настроена. Пока для восстановления нужен этот код.'}</p>{mode==='register'&&state?.mailReady&&<button className="text-button" disabled={busy} onClick={sendVerification}>Повторить письмо подтверждения</button>}{error&&<p className="auth-error" role="alert">{error}</p>}<label className="auth-check"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>Я сохранил код в безопасном месте</label><button className="button primary full" disabled={!ack} onClick={()=>{if(mode==='reset'){setSavedCode('');setAck(false);changeMode('login')}else void finish()}}>{mode==='reset'?'Войти с новым паролем':'Перейти к документам'}</button></>:<>
 <div className="eyebrow">ЛИЧНОЕ ПРОСТРАНСТВО</div><h1 id={tabsId+"-heading"}>{title}</h1><p>{description}</p>{!logout&&returnTo!=='/'&&<p role="status">После входа откроется ваш договор. Статус оплаты сохранён.</p>}
 {!logout&&state?.user&&!state.user.emailVerified&&mode!=='verify'&&state.mailReady&&<div className="auth-verify"><p>Адрес {state.user.email} ещё не подтверждён. Подтвердите его для восстановления пароля по почте.</p><button className="button secondary full" disabled={busy} onClick={sendVerification}>Подтвердить мой email</button></div>}
 {!logout&&['login','register'].includes(mode)&&<div className="auth-tabs" role="tablist" aria-label="Вход или регистрация">{(['login','register'] as const).map(value=><button type="button" key={value} role="tab" id={tabsId+'-'+value} aria-selected={mode===value} aria-controls={tabsId+'-panel'} tabIndex={mode===value?0:-1} disabled={busy} className={mode===value?'active':''} onClick={()=>changeMode(value)} onKeyDown={e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?'login':e.key==='End'?'register':value==='login'?'register':'login';changeMode(next);document.getElementById(tabsId+'-'+next)?.focus()}}}>{value==='login'?'Вход':'Регистрация'}</button>)}</div>}
 <form id={tabsId+'-panel'} role={!logout&&['login','register'].includes(mode)?'tabpanel':undefined} aria-labelledby={!logout&&['login','register'].includes(mode)?tabsId+'-'+mode:tabsId+'-heading'} onSubmit={submit}>{!logout&&<>
 {!['reset','verify'].includes(mode)&&<label className="field"><span>Email</span><input autoComplete="email" type="email" required maxLength={254} value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com"/></label>}
 {!['forgot','verify'].includes(mode)&&<label className="field"><span>{mode==='recover'||mode==='reset'?'Новый пароль':'Пароль'}</span><div className="auth-password"><input type={showPassword?'text':'password'} autoComplete={mode==='login'?'current-password':'new-password'} required minLength={mode==='login'?1:12} maxLength={256} value={password} onChange={e=>setPassword(e.target.value)} placeholder={mode==='login'?'Ваш пароль':'Не менее 12 символов'}/><button type="button" className="auth-password-toggle" aria-label={showPassword?'Скрыть пароль':'Показать пароль'} aria-pressed={showPassword} onClick={()=>setShowPassword(value=>!value)}>{showPassword?<EyeOff size={19}/>:<Eye size={19}/>}</button></div></label>}
 {mode==='recover'&&<label className="field"><span>Код восстановления</span><input required autoComplete="off" spellCheck={false} value={code} onChange={e=>setCode(e.target.value.trim())}/></label>}
 {mode==='register'&&<><p className="muted">{state?.mailReady?'После регистрации отправим письмо для подтверждения email. Вы также получите резервный код восстановления.':'Почтовая отправка ещё не настроена. После регистрации вы получите резервный код восстановления.'}</p></>}
 {mode==='forgot'&&!state?.mailReady&&<p>Отправка писем пока недоступна. Используйте резервный код ниже.</p>}
 </>}{error&&<div className="auth-error" role="alert">{error}</div>}{notice&&<p role="status">{notice}</p>}<button className="button primary full" type="submit" disabled={busy||completed||(!logout&&mode==='forgot'&&!state?.mailReady)}>{busy?'Подождите…':logout?'Выйти':({login:'Войти',register:'Создать аккаунт',recover:'Задать новый пароль',forgot:'Отправить ссылку',reset:'Сохранить новый пароль',verify:completed?'Email подтверждён':'Подтвердить email'} as const)[mode]}</button></form>
 {!logout&&<>{mode==='login'?<button className="text-button" onClick={()=>changeMode('forgot')}>Забыли пароль?</button>:!['register','verify'].includes(mode)?<button className="text-button" onClick={()=>changeMode('login')}>Вернуться ко входу</button>:null}{mode==='forgot'&&<button className="text-button" onClick={()=>changeMode('recover')}>Использовать резервный код</button>}
 </>}
 </>}{!embedded&&<a href="/" className="auth-back">← На главную</a>}</section>{!embedded&&<p className="auth-footer">Ваши документы доступны только вашему аккаунту.</p>}</div>
}


export function AuthDialog({onClose,onAuthenticated}:{onClose:()=>void;onAuthenticated:()=>void|Promise<void>}){
 const dialogRef=useRef<HTMLDialogElement>(null);
 const [dismissLocked,setDismissLocked]=useState(false);
 useEffect(()=>{
  const dialog=dialogRef.current;
  const previouslyFocused=document.activeElement instanceof HTMLElement?document.activeElement:null;
  const overflow=document.body.style.overflow;
  document.body.style.overflow='hidden';
  dialog?.showModal();
  dialog?.querySelector<HTMLInputElement>('input[type="email"]')?.focus();
  return()=>{dialog?.close();document.body.style.overflow=overflow;previouslyFocused?.focus()};
 },[]);
 return <dialog ref={dialogRef} className="criterion-auth-dialog" aria-label="Вход и регистрация" onCancel={e=>{e.preventDefault();if(!dismissLocked)onClose()}} onClick={e=>{if(!dismissLocked&&e.target===e.currentTarget){const bounds=e.currentTarget.getBoundingClientRect();if(e.clientX<bounds.left||e.clientX>bounds.right||e.clientY<bounds.top||e.clientY>bounds.bottom)onClose()}}}>
  <AuthScreen embedded onClose={onClose} onAuthenticated={onAuthenticated} onDismissLockedChange={setDismissLocked}/>
 </dialog>;
}
