'use client';
import { useEffect,useEffectEvent,useState,useRef,Fragment } from 'react';
import { ArrowUpRight,ArrowRight,ArrowLeft,Plus,FileText,FolderOpen,Search,Settings2,MessageSquare,Check,CheckCheck,ChevronRight,Download,X,ShieldCheck,BriefcaseBusiness,Package,KeyRound,Hammer,Shield,Menu,Sparkles,LoaderCircle,Send,History,Pencil,RefreshCw,Trash2,LogOut,Printer,Info,CheckCircle2,ExternalLink,LockKeyhole } from 'lucide-react';
import { KINDS,fields,demoContract,review,snapshot,type Contract,type Kind,type Section,type Materials } from '../lib/criterion/domain';
import { sectionHeading,textRuns } from '../lib/criterion/format';
import { download,downloadBlob } from '../lib/criterion/export';
import {ApiError,asClientError,requestJson,requestResponse,signInPath,type ClientOperation} from '../lib/criterion/client-session';
import {CriterionError} from '../components/criterion-error';
import {LockedDraft} from '../components/criterion-payment';
import {AuthDialog} from '../components/criterion-auth';
import {ContractProgress} from '../components/criterion-progress';
type Summary=Pick<Contract,'id'|'title'|'kind'|'stage'|'updatedAt'|'revision'>;
type State={user:{name:string;email:string}|null;ai:boolean;documents:Summary[];materials:Materials;paymentsReady?:boolean;paymentTestMode?:boolean};
const stages={interview:'Интервью',ready:'Готов к черновику',review:'На проверке',final:'Итоговая версия'};
const kindIcon:Record<string,typeof FileText>={services:BriefcaseBusiness,sale:Package,lease:KeyRound,work:Hammer,nda:Shield,other:FileText};
function Mark({small=false}:{small?:boolean}){return <svg className={small?'mark small':'mark'} viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M28 10a14 14 0 1 0 0 20M11 16h20M11 24h20" stroke="currentColor" strokeWidth="2.3"/></svg>}
function prettyDate(date:string){return new Date(date).toLocaleDateString('ru-RU',{day:'numeric',month:'short'})}
function api<T=Contract>(path:string, operation:ClientOperation, method='GET', body?:unknown):Promise<T> {
 function responseMatches(value:unknown) {
   if(operation!=='checkout'&&operation!=='payment_status')return true;
   const result=value as Partial<{document:Contract;paymentUrl:unknown;status:unknown}>|null;
   const next=result?.document;
   const expected=(body as {documentId?:string}|undefined)?.documentId;
   if(!next||next.id!==expected||!next.billing||typeof next.billing.locked!=='boolean'||
      !Array.isArray(next.sections)||!Array.isArray(next.messages)||!Array.isArray(next.issues)||!Array.isArray(next.versions))return false;
   return operation==='checkout' ? (result.paymentUrl===null||typeof result.paymentUrl==='string'&&result.paymentUrl.startsWith('https://'))
     : typeof result.status==='string';
 }
 return requestJson<T>(path,{method,cache:'no-store',headers:body?{'Content-Type':'application/json'}:undefined,
   body:body?JSON.stringify(body):undefined},operation,responseMatches);
}
function actionOperation(action:string):ClientOperation {
 switch(action){case 'generate':case 'revise':case 'message':case 'review': return action; default: return 'save';}
}
// The tab stores only a checkout timestamp under this document's key while its result is unknown.
function checkoutTime(id:string) {
 try { const value=Number(sessionStorage.getItem('criterion.checkout-pending.'+id)); return Number.isFinite(value)&&value>0 ? value : 0; }
 catch { return 0; }
}
export default function Workspace(){
 const [state,setState]=useState<State|null>(null),[view,setView]=useState('home'),[doc,setDoc]=useState<Contract|null>(null),[newKind,setNewKind]=useState<Kind|null>(null),[newTitle,setNewTitle]=useState(''),[newMode,setNewMode]=useState<'form'|'ai'>('form'),[busy,setBusy]=useState(''),[error,setError]=useState<ApiError|null>(null),[toast,setToast]=useState(''),[query,setQuery]=useState(''),[filter,setFilter]=useState('all'),[mobile,setMobile]=useState(false),[tab,setTab]=useState<'review'|'history'|'context'>('review'),[edit,setEdit]=useState(false),[editSections,setEditSections]=useState<Section[]>([]),[formStep,setFormStep]=useState(0),[message,setMessage]=useState(''),[facts,setFacts]=useState<Record<string,string>>({}),[context,setContext]=useState(''),[confirm,setConfirm]=useState<'finalize'|'delete'|null>(null),[previewVersion,setPreviewVersion]=useState<number|null>(null),[saved,setSaved]=useState(true);
 const scrollRef=useRef<HTMLDivElement>(null);const initialOpen=useRef(false);const requestActive=useRef(false);
 const demo=doc?.id==='example';
 const locked=Boolean(doc?.billing?.locked),aiExhausted=doc?.billing?.aiRemaining===0;
 const [paymentNotice,setPaymentNotice]=useState('');
 const [pendingId,setPendingId]=useState<string|null>(null);
 const pendingRef=useRef({id:'',since:0});
 const paymentEpoch=useRef(0);
 function markPending(id:string,since:number) {
   pendingRef.current={id,since};setPendingId(id);
   try { sessionStorage.setItem('criterion.checkout-pending.'+id,String(since)); } catch { /* memory remains available */ }
 }
 function clearPending(id:string) {
   if(pendingRef.current.id===id)pendingRef.current={id:'',since:0};
   setPendingId(current=>current===id?null:current);
   try { sessionStorage.removeItem('criterion.checkout-pending.'+id); } catch { /* no storage available */ }
 }
 function applyPaymentCheck(next:Contract,status:string) {
   if(next.billing?.checkRequired || ['INITIALIZING','INIT_OUTCOME_UNKNOWN'].includes(status)) return;
   const since=pendingRef.current.id===next.id ? pendingRef.current.since : checkoutTime(next.id);
   // A status read can race the original checkout before its order is reserved.
   if(status==='NOT_STARTED' && since && Date.now()-since<30_000) return;
   clearPending(next.id);
 }
 const [authRequired,setAuthRequired]=useState(false);
 const [authOpen,setAuthOpen]=useState(false);
 const currentStep=doc?(doc.sections.length?(locked?1:doc.stage==='final'?3:2):0):null;
 const interviewReady=doc?.mode==='ai'&&doc.stage==='ready'&&!doc.sections.length;
 function openAuth(){setMobile(false);setAuthOpen(true)}
 async function load(){const s=await api<State>('/api/workspace','workspace');setState(s);return s}
 const openInitialDocument=useEffectEvent(async (state:State)=>{
  const query=new URLSearchParams(location.search),id=query.get('document');
  if(!id||initialOpen.current)return;
  initialOpen.current=true;
  if(!state.user){location.replace(signInPath(location.pathname+location.search));return}
  await openDocument(id);if(query.has('payment'))await checkPayment(id);
 });
 useEffect(()=>{
   let active=true;
   api<State>('/api/workspace','workspace').then(state=>{
     if(active){setState(state);return openInitialDocument(state)}
   }).catch(cause=>{if(active)setError(asClientError(cause,'workspace'))});
   return ()=>{active=false};
 },[]);
 useEffect(()=>{if(!toast)return;const t=setTimeout(()=>setToast(''),4500);return()=>clearTimeout(t)},[toast]);
 useEffect(()=>{scrollRef.current?.scrollIntoView({behavior:'smooth',block:'nearest'})},[doc?.messages.length]);
 useEffect(()=>{const onUnload=(e:BeforeUnloadEvent)=>{if(!saved||edit){e.preventDefault();e.returnValue=''}};window.addEventListener('beforeunload',onUnload);return()=>window.removeEventListener('beforeunload',onUnload)},[saved,edit]);
 const pollingId=doc&&!demo&&locked&&doc.sections.length ? doc.id : null;
 const acceptPoll=useEffectEvent((next:Contract,status?:string)=>{
   if(next.id!==doc?.id)return;
   if(status)applyPaymentCheck(next,status);
   if(next.billing?.state==='paid'&&!next.billing.locked){
     clearPending(next.id);sync(next);setPaymentNotice('Оплата подтверждена. Договор открыт.');void load().catch(()=>{});return;
   }
   if(next.billing) setDoc(current=>current?.id===next.id?{...current,billing:next.billing}:current);
 });
 useEffect(()=>{
  if(!pollingId)return;
  const id=pollingId;let stopped=false,inFlight=false,checks=0;
  async function refresh(){
   if(stopped||inFlight||requestActive.current||document.visibilityState==='hidden')return;
   inFlight=true;const epoch=paymentEpoch.current;
   try{
    // Background reads never replace a newer checkout or an explicit status request.
    if(++checks%4===0) {
      const result=await api<{document:Contract;status:string}>('/api/payments/status','payment_status','POST',{documentId:id});
      if(!stopped && !requestActive.current && paymentEpoch.current===epoch)acceptPoll(result.document,result.status);
    } else {
      const next=await api('/api/documents/'+id,'open');
      if(!stopped && !requestActive.current && paymentEpoch.current===epoch)acceptPoll(next);
    }
   }catch{/* Preserve the last known state; the next poll or the manual check can retry. */}
   finally{inFlight=false}
  }
  const timer=setInterval(refresh,4000);
  window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
  return()=>{stopped=true;clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh)};
 },[pollingId]);
 function sync(next:Contract){setDoc(next);setFacts(next.facts);setContext(next.context);setSaved(true);setPreviewVersion(null);if(next.id!=='example')history.replaceState(null,'',`/?document=${next.id}`)}
 async function run(label:string,fn:()=>Promise<void>){if(requestActive.current)return;requestActive.current=true;setBusy(label);setError(null);try{await fn();setAuthRequired(false)}catch(e){setAuthRequired(e instanceof ApiError&&e.status===401);setError(asClientError(e,'ui'))}finally{requestActive.current=false;setBusy('')}}
 async function saveForm(){if(!doc)return;if(demo){sync({...doc,facts,context});return}const next=await api(`/api/documents/${doc.id}`,'save','PATCH',{action:'save',revision:doc.revision,facts,context});sync(next)}
 async function navigate(next:string){await run('Сохраняем',async()=>{if(!saved&&doc&&['interview','ready'].includes(doc.stage))await saveForm();if(edit)throw new ApiError(0,'Сохраните правки договора или нажмите «Отменить» перед переходом.','UNSAVED_CHANGES','save');setView(next);setDoc(null);setPaymentNotice('');setMobile(false);setConfirm(null);history.replaceState(null,'','/');await load()})}
 async function openDocument(id:string){setPaymentNotice('');await run('Открываем документ',async()=>{const d=id==='example'?demoContract():await api(`/api/documents/${id}`,'open');const since=checkoutTime(id);if(since&&d.billing?.locked)markPending(id,since);else if(!d.billing?.locked)clearPending(id);sync(d);setView('document');setMobile(false);setEdit(false);setFormStep(0);setTab('review')})}
 async function create(){if(!newKind)return;await run('Создаём документ',async()=>{if(edit)throw new ApiError(0,'Сохраните правки текущего договора.','UNSAVED_CHANGES','save');if(!saved&&doc&&['interview','ready'].includes(doc.stage))await saveForm();const d=await api('/api/documents','create','POST',{kind:newKind,mode:newMode,title:newTitle||undefined});sync(d);setNewKind(null);setNewTitle('');setView('document');setFormStep(0);await load()})}
 async function action(name:string,extra:Record<string,unknown>={}){if(!doc)return;await run(name==='generate'?'Составляем и проверяем договор':name==='revise'?'Вносим правки':name==='message'?'Criterion отвечает':'Сохраняем изменения',async()=>{
  let d:Contract;
  if(demo){d=structuredClone(doc);if(name==='edit'){d.sections=extra.sections as Section[];d.issues=review(d);d.versions.push(snapshot(d,'Ручные правки'))}if(name==='review')d.issues=review(d);if(name==='finalize'){d.stage='final';d.versions.push(snapshot(d,'Итоговая версия'))}if(name==='reopen')d.stage='review';if(name==='restore'){const v=d.versions.find(v=>v.number===extra.version)!;d.sections=v.sections;d.issues=review(d);d.stage='review';d.versions.push(snapshot(d,'Восстановленная версия'))}if(name==='delete'){setDoc(null);setView('home');setConfirm(null);return}d.revision++;}
  else{d=await api(`/api/documents/${doc.id}`,actionOperation(name),'PATCH',{action:name,revision:doc.revision,...(['generate','save'].includes(name)?{facts,context}:{}),...extra});if(name==='delete'){setDoc(null);setView('home');setConfirm(null);history.replaceState(null,'','/');await load();return}}
  sync(d);setMessage('');setConfirm(null);setEdit(false);if(name!=='message')setToast(demo?'Изменения в примере действуют до закрытия страницы':'Изменения сохранены');await load();
 })}
 const filtered=(state?.documents||[]).filter(d=>(filter==='all'||d.stage===filter)&&d.title.toLowerCase().includes(query.toLowerCase()));
 const currentSections=previewVersion?doc?.versions.find(v=>v.number===previewVersion)?.sections:doc?.sections;
 const docDirty=!saved||edit||previewVersion!==null;
 async function checkPayment(id=doc?.id){if(!id||id==='example')return;paymentEpoch.current++;await run('Проверяем оплату',async()=>{const result=await api<{document:Contract;status:string}>('/api/payments/status','payment_status','POST',{documentId:id});applyPaymentCheck(result.document,result.status);sync(result.document);setPaymentNotice(result.document.billing?.state==='paid'?'Оплата подтверждена. Договор открыт.':result.status==='REFUNDED'?'Оплата возвращена.':result.status==='NOT_STARTED'?'Оплата ещё не начата.':['REJECTED','CANCELED','DEADLINE_EXPIRED','AUTH_FAIL','INIT_FAILED','REVERSED'].includes(result.status)?'Оплата не завершена. Можно повторить попытку.':'Ожидаем подтверждение банка. Договор откроется автоматически после оплаты.');await load()})}
 async function pay(receiptEmail:string){
  if(!doc||requestActive.current||doc.billing?.checkRequired||pendingId===doc.id)return;
  const id=doc.id;paymentEpoch.current++;markPending(id,Date.now());
  await run('Открываем страницу Т-Банка',async()=>{
   let result:{document:Contract;paymentUrl:string|null};
   try { result=await api('/api/payments/checkout','checkout','POST',{documentId:id,receiptEmail}); }
   catch(cause) {
    if(cause instanceof ApiError && cause.status>=400 && cause.status<500 && cause.code!=='PAYMENT_CHECK_REQUIRED') clearPending(id);
    throw cause;
   }
   clearPending(id);sync(result.document);
   if(result.paymentUrl)window.location.assign(result.paymentUrl);
   else setPaymentNotice('Оплата подтверждена. Договор открыт.');
  });
 }
 async function exportDoc(format:'docx'|'txt'){if(!doc||locked)return;if(demo){download(doc,format);return}await run('Готовим файл',async()=>{const response=await requestResponse(`/api/documents/${doc.id}/export?format=${format}`,{cache:'no-store'},'export');let blob:Blob;try{blob=await response.blob()}catch{throw new ApiError(response.status,'Не удалось получить файл целиком. Повторите выгрузку.','CLIENT_RESPONSE_INVALID','export',response.headers.get('X-Request-ID'))}downloadBlob(blob,`${doc.title}.${format}`)})}
 return <div className="shell">
 <aside className={`sidebar ${mobile?'show':''}`}>
  <button className="brand" onClick={()=>navigate('home')}><Mark/><span>criterion<span className="brand-dot">.</span></span></button>
  <div className="workspace-label"><span>ЛИЧНОЕ ПРОСТРАНСТВО</span><span className="tiny-pill">v1.15</span></div>
  <button className="button primary newdoc" onClick={()=>{setNewKind('services');setNewMode(state?.ai?'ai':'form')}}><Plus size={18}/>Новый договор</button>
  <nav>
   <button className={view==='home'?'selected':''} onClick={()=>navigate('home')}><FolderOpen size={18}/>Мои документы<span className="nav-count">{state?.documents.length||0}</span></button>
   <button className={view==='settings'?'selected':''} onClick={()=>navigate('settings')}><Settings2 size={18}/>Аккаунт</button>
  </nav>
  <div className="sidebar-caption">РАБОЧИЙ ПРОЦЕСС</div>
  <ContractProgress current={currentStep}/>
  <div className="sidebar-bottom"><div className="private-note"><LockKeyhole size={16}/><span>Ваше приватное<br/>рабочее пространство</span></div><div className="profile">{state?.user?<button className="account-entry" onClick={()=>navigate('settings')} aria-label="Открыть настройки аккаунта"><div className="avatar">{state.user.name.slice(0,1).toUpperCase()}</div><span><strong>Личный кабинет</strong><small>{state.user.email}</small></span><ChevronRight size={17}/></button>:<button className="button secondary account-signin" onClick={openAuth}><KeyRound size={17}/>Вход / Регистрация<ArrowRight size={16}/></button>}</div></div>
 </aside>
 {mobile&&<button className="backdrop" aria-label="Закрыть меню" onClick={()=>setMobile(false)}/>}
 <main>
  <header className="topbar"><button className="icon-button mobile-menu" aria-label="Открыть меню" onClick={()=>setMobile(true)}><Menu size={22}/></button><div className="breadcrumbs">Рабочее пространство<ChevronRight size={14}/><span>{view==='document'?'Договор':view==='settings'?'Аккаунт':'Мои документы'}</span></div><div className="topbar-right">{!state?.user&&<button className="button secondary topbar-signin" onClick={openAuth}>Вход / Регистрация</button>}<span className="live-dot"/>{state?.ai?'ИИ подключён':'Режим конструктора'}<span className="top-divider"/><span className="top-date">{new Date().toLocaleDateString('ru-RU',{day:'numeric',month:'long'})}</span></div></header>
  <CriterionError error={error} onDismiss={()=>setError(null)}/>
  {authRequired&&<div className="session-notice" role="status"><p>Войдите в новой вкладке, затем вернитесь сюда и повторите действие. Несохранённые правки остаются в этой вкладке.</p><a className="button secondary" href={signInPath(doc&&!demo?`/?document=${doc.id}`:'/')} target="_blank" rel="noopener noreferrer">Войти в аккаунт<ExternalLink size={16}/></a></div>}
  {!state&&!error&&<div className="loading"><LoaderCircle className="spin"/>Открываем пространство…</div>}
  {view==='home'&&<div className="page dashboard">
   <div className="eyebrow">МЕНЬШЕ ФОРМАЛЬНОСТЕЙ. БОЛЬШЕ ЯСНОСТИ.</div>
   <div className="page-heading"><h1>Ваши договорённости.<br/><em>Всё на своих местах.</em></h1><p>От первых условий до готового документа.<br/>Один понятный процесс — под вашим контролем.</p></div>
   <section className="hero-card"><div className="hero-copy"><div className="tag"><span/>CRITERION · СОЗДАНИЕ ДОГОВОРОВ</div><h2>Начните с того,<br/>о чём договорились.</h2><p>Соберите условия, проверьте детали<br/>и сохраните договор в удобном формате.</p><div className="hero-actions"><button className="button dark" onClick={()=>{setNewKind('services');setNewMode(state?.ai?'ai':'form')}}>Создать договор<ArrowUpRight size={18}/></button><button className="text-button" onClick={()=>openDocument('example')}>Посмотреть пример<ArrowRight size={16}/></button></div></div><div className="hero-art" aria-hidden="true"><div className="art-orbit orbit-a"/><div className="art-orbit orbit-b"/><div className="paper-back"/><div className="art-paper"><div className="paper-top"><Mark small/><span>CRITERION</span></div><div className="paper-title">Договор<br/>оказания услуг</div><div className="paper-sub">Условия, в которых всё понятно.</div><div className="paper-lines"><i/><i/><i/><i/><i/><i/><i/></div><div className="paper-sign"><svg viewBox="0 0 100 30"><path d="M5 23Q36-7 28 20T50 5Q45 24 69 15L90 17" fill="none" stroke="currentColor" strokeWidth="1.7"/></svg><span>Подпись</span></div></div><div className="art-note"><CheckCircle2 size={17}/><span>Каждая деталь на месте</span></div><div className="art-spark">✳</div></div></section>
   <section className="legal-expertise" aria-labelledby="expertise-title">
    <div className="expertise-copy"><span className="eyebrow">ЮРИДИЧЕСКАЯ ЭКСПЕРТИЗА В ОСНОВЕ</span><h2 id="expertise-title">Создано юристами.<br/>Продумано для ваших договоров.</h2><p>В основе Criterion — опыт юридической практики Андрея Витько с 2019 года: сопровождение бизнеса, IT-проектов и защита интеллектуальных прав. Этот опыт помогает выстроить работу с договором вокруг того, что важно в сделке: обязательств сторон, сроков, оплаты и ответственности.</p><a className="expertise-link" href="https://andreyvitko.com/" target="_blank" rel="noopener noreferrer">Об образовании и практике Андрея<ArrowUpRight size={17}/></a></div>
    <div className="expertise-credentials"><h3>Андрей Витько</h3><p>Юрист · бизнес, IT и интеллектуальные права</p><dl><div><dt>МГУ · 2013</dt><dd>Юридический факультет</dd></div><div><dt>Hofstra University · 2016</dt><dd>Juris Doctor — профессиональная степень в области права, США</dd></div><div><dt>Юридическая практика с 2019 года</dt><dd>Собственная практика и сопровождение юридических проектов</dd></div></dl></div>
   </section>
   <section className="criterion-benefits" aria-labelledby="benefits-title"><div className="benefits-heading"><span className="eyebrow">ОТ ДИАЛОГА К ДОКУМЕНТУ</span><h2 id="benefits-title">Почему Criterion, а не просто чат?</h2><p>Вы описываете свою договорённость обычными словами. Criterion помогает уточнить условия, подготовить связный текст и проверить детали перед согласованием.</p></div><div className="benefits-grid"><article><MessageSquare size={20}/><h3>Вопросы по делу</h3><p>Кто и что должен сделать, в какой срок и за какую сумму? Сервис последовательно уточняет условия вашей сделки. Вам достаточно отвечать на вопросы.</p></article><article><CheckCheck size={20}/><h3>Договор под ваши условия</h3><p>Ответы становятся основой текста: предмет, обязанности, расчёты и ответственность сторон. Проверка помогает заметить пробелы и противоречия до согласования.</p></article><article><History size={20}/><h3>Правки и готовый файл</h3><p>Уточняйте формулировки, сравнивайте версии и сохраняйте договор в Word. От первого ответа до документа для согласования — в одном месте.</p></article></div></section>
   <section className="types-section"><div className="section-heading"><h2>Что оформляем?</h2><span>Выберите подходящий тип договора</span></div><div className="type-grid">{KINDS.slice(0,5).map(k=>{const Icon=kindIcon[k.id];return <button key={k.id} onClick={()=>{setNewKind(k.id);setNewMode(state?.ai?'ai':'form')}} className="type-card"><Icon size={21}/><span>{k.short}</span><ArrowUpRight size={15}/></button>})}</div></section>
   <section className="documents-section"><div className="section-heading"><div className="heading-with-count"><h2>Мои документы</h2><span>{state?.documents.length||0}</span></div><label className="search-box"><Search size={16}/><input aria-label="Поиск документов" placeholder="Найти документ" value={query} onChange={e=>setQuery(e.target.value)}/></label></div><div className="filter-tabs">{[['all','Все документы'],['interview','В работе'],['review','На проверке'],['final','Готовые']].map(([k,t])=><button className={filter===k?'active':''} onClick={()=>setFilter(k)} key={k}>{t}</button>)}</div>
   {filtered.length?<div className="document-list"><div className="table-labels"><span>НАЗВАНИЕ ДОКУМЕНТА</span><span>СТАТУС</span><span>ОБНОВЛЁН</span><span/></div>{filtered.map(d=><button className="document-row" key={d.id} onClick={()=>openDocument(d.id)}><div className="doc-name"><span className="doc-icon"><FileText size={20}/></span><span><strong>{d.title}</strong><small>{KINDS.find(k=>k.id===d.kind)?.name}</small></span></div><span className={`status ${d.stage}`}>{stages[d.stage]}</span><span className="doc-date">{prettyDate(d.updatedAt)}</span><ArrowUpRight size={18}/></button>)}</div>:<div className="empty-docs"><div className="empty-illustration"><FileText size={28}/></div><div><h3>{query||filter!=='all'?'Здесь пока нет документов':'Место для ваших первых договорённостей'}</h3><p>{query||filter!=='all'?'Измените поиск или выберите другой статус.':'Создайте договор — он сохранится здесь вместе с историей правок.'}</p></div><button className="text-button" onClick={()=>{setNewKind('services');setNewMode(state?.ai?'ai':'form')}}>Начать<ArrowRight size={16}/></button></div>}
   </section><div className="bottom-line"><Mark small/><span>Ясные условия — основа хороших отношений.</span><span>Criterion 1.15</span></div>
  </div>}
  {view==='document'&&doc&&<div className="document-workspace">
   <div className="document-top"><div><button className="back-link" onClick={()=>navigate('home')}><ArrowLeft size={15}/>К документам</button><h1>{doc.title}</h1><div className="document-meta"><span className={`status ${doc.stage}`}>{locked?'Ожидает оплаты':stages[doc.stage]}</span><span>{demo?'Пример · вымышленные данные':saved?<><CheckCheck size={14}/>Сохранено</>:'Есть несохранённые изменения'}</span>{doc.versions.length>0&&<span>Версия {doc.versions.at(-1)?.number}</span>}</div></div><div className="doc-actions">{doc.sections.length>0&&!locked&&<><button className="button secondary" onClick={()=>exportDoc('docx')} disabled={!!busy||docDirty}><Download size={16}/>Word</button><button className="icon-button bordered" aria-label="Печать или сохранить в PDF" title="Печать / PDF" onClick={()=>window.print()} disabled={docDirty}><Printer size={18}/></button></>}<button className="icon-button bordered" aria-label="Удалить документ" onClick={()=>setConfirm('delete')} disabled={!!busy}><Trash2 size={17}/></button></div></div>
   <div className="steps">{[['01','Условия'],['02','Черновик'],['03','Проверка'],['04','Документ']].map(([n,t],i)=>{const current=currentStep??0;return <div key={n} className={i===current?'current':i<current?'complete':''}><span>{i<current?<Check size={14}/>:n}</span>{t}{i<3&&<div/>}</div>})}</div>
   {paymentNotice&&<div className="info-strip" role="status"><Info size={16}/>{paymentNotice}</div>}
   {demo&&<div className="info-strip"><Info size={16}/>Демонстрационный договор: все стороны и реквизиты вымышлены. Можно редактировать и скачивать. Изменения действуют только до закрытия страницы.</div>}
   {!doc.sections.length?<div className="interview-layout"><section className="interview-panel"><div className="panel-heading"><div><div className="eyebrow">ШАГ 01 · {doc.mode==='ai'?'ИНТЕРВЬЮ':'АНКЕТА'}</div><h2>{doc.mode==='ai'?'Расскажите о договорённости':'Соберём основные условия'}</h2></div><span className="round-icon">{doc.mode==='ai'?<Sparkles size={19}/>:<Pencil size={19}/>}</span></div>
    {doc.mode==='form'?<><p className="muted intro">Заполняйте только то, что уже согласовано. Неизвестные сведения будут отмечены в черновике.</p><div className="form-step-tabs">{['Стороны и задача','Деньги и сроки','Важные детали','Реквизиты'].map((t,i)=><button key={t} onClick={()=>setFormStep(i)} className={formStep===i?'active':''}>{i+1}. {t}</button>)}</div><div className="form-fields">{fields(doc.kind).filter(f=>f.group===formStep).map(f=><label className="field" key={f.key}><span>{f.label}</span><textarea rows={['subject','payment','acceptance','detailsA','detailsB'].includes(f.key)?3:2} maxLength={6000} placeholder={f.placeholder} value={facts[f.key]||''} onChange={e=>{setFacts({...facts,[f.key]:e.target.value});setSaved(false)}}/></label>)}{formStep===2&&<label className="field"><span>Что ещё важно учесть?</span><textarea rows={4} maxLength={15000} placeholder="Особые пожелания и обстоятельства. В режиме анкеты они сохранятся как заметка для проверки." value={context} onChange={e=>{setContext(e.target.value);setSaved(false)}}/></label>}</div><div className="form-footer"><button className="text-button" onClick={()=>run('Сохраняем',saveForm)} disabled={saved||!!busy}><Check size={16}/>Сохранить</button>{formStep<3?<button className="button primary" disabled={!!busy} onClick={()=>run('Сохраняем условия',async()=>{await saveForm();setFormStep(formStep+1)})}>Продолжить<ArrowRight size={16}/></button>:<button className="button primary" disabled={!!busy} onClick={()=>action('generate')}>Составить черновик<ArrowRight size={16}/></button>}</div></>:<><div className="chat-messages">{doc.messages.map(m=><div key={m.id} className={`chat-message ${m.role}`}><div className="chat-avatar">{m.role==='assistant'?<Mark small/>:'Вы'}</div><div><strong>{m.role==='assistant'?'Criterion':'Вы'}</strong><p>{m.text}</p></div></div>)}<div ref={scrollRef}/></div><form className="chat-input" onSubmit={e=>{e.preventDefault();if(message.trim())action('message',{text:message.trim()})}}><textarea rows={3} placeholder="Ваш ответ или вопрос…" aria-label="Сообщение Criterion" value={message} onChange={e=>setMessage(e.target.value)} maxLength={12000}/><button className="button primary" aria-label="Отправить сообщение" disabled={!!busy||!message.trim()}><Send size={18}/></button></form><div className={`chat-bottom ${interviewReady?'interview-ready':''}`}><span role="status">{interviewReady?<><CheckCircle2 size={16}/><span><strong>Условия собраны — можно продолжать</strong><small>Следующий шаг — оплата и получение черновика.</small></span></>:'Недостающие данные можно уточнить позже'}</span><button className={`button draft-cta ${interviewReady&&!busy?'draft-cta-ready':''}`} disabled={!!busy} onClick={()=>action('generate')}>Перейти к черновику<ArrowRight size={16}/></button></div></>}
   </section><aside className="interview-aside"><span className="eyebrow">КАРТОЧКА ДОГОВОРА</span><h3>{KINDS.find(k=>k.id===doc.kind)?.name}</h3><dl>{fields(doc.kind).slice(0,6).map(f=><div key={f.key}><dt>{f.label}</dt><dd className={facts[f.key]?'':'not-set'}>{facts[f.key]||'Пока не указано'}</dd></div>)}</dl><div className="aside-note"><ShieldCheck size={22}/><h4>Вы контролируете результат</h4><p>Перед скачиванием сможете изменить любой пункт и проверить замечания.</p></div><div className="aside-note subtle"><Info size={18}/><p>{doc.mode==='ai'?'Уточняйте условия прямо в диалоге. Когда всё будет готово, переходите к черновику.':state?.ai?'ИИ подготовит текст договора по условиям, которые вы указали в анкете.':'Анкета заполняет базовую структуру без ИИ. Свободный текст не преобразуется в юридические условия автоматически.'}</p></div></aside></div>:locked?<LockedDraft doc={doc} checking={pendingId===doc.id&&busy!=='Открываем страницу Т-Банка'} busy={!!busy} ready={Boolean(state?.paymentsReady)} testMode={Boolean(state?.paymentTestMode)} email={state?.user?.email} onPay={pay} onCheck={()=>checkPayment()}/>:<div className="review-layout"><div className="paper-column"><div className="document-toolbar"><span><FileText size={16}/>{previewVersion?`Просмотр версии ${previewVersion}`:'Текст договора'}</span><div>{previewVersion?<button className="text-button" onClick={()=>setPreviewVersion(null)}>Текущая версия</button>:!edit&&doc.stage!=='final'?<button className="text-button" disabled={!!busy} onClick={()=>{setEditSections(structuredClone(doc.sections));setEdit(true)}}><Pencil size={15}/>Редактировать</button>:null}{edit&&<><button className="text-button" onClick={()=>setEdit(false)}>Отменить</button><button className="button primary small-button" disabled={!!busy} onClick={()=>action('edit',{sections:editSections})}>Сохранить</button></>}</div></div><article className={`contract-paper ${edit?'editing':''}`}><div className="paper-brand"><Mark small/>CRITERION<span>{doc.stage==='final'?'ИТОГОВАЯ ВЕРСИЯ':'ЧЕРНОВИК'}</span></div><table className="contract-table"><tbody><tr><td><h2>{doc.title}</h2></td></tr>{(edit?editSections:currentSections)?.map(s=><Fragment key={s.id}><tr className="contract-divider" aria-hidden="true"><td>&nbsp;</td></tr><tr><td><section id={`section-${s.id}`}>{sectionHeading(s)&&<h3>{sectionHeading(s)}</h3>}{edit?<textarea aria-label={s.title} value={s.content} rows={Math.max(4,Math.min(15,s.content.split('\n').length+3))} maxLength={18000} onChange={e=>setEditSections(prev=>prev.map(v=>v.id===s.id?{...v,content:e.target.value}:v))}/>:<p>{textRuns(s.content,doc,s.id).map((r,j)=>r.missing?<mark key={j}>{r.text}</mark>:r.bold?<strong key={j}>{r.text}</strong>:r.text)}</p>}</section></td></tr></Fragment>)}</tbody></table><footer>Criterion · {doc.stage==='final'?'Версия выбрана пользователем':'Черновик для согласования'}</footer></article><div className="document-downloads"><button className="text-button" disabled={docDirty||!!busy} onClick={()=>exportDoc('txt')}>Скачать TXT<Download size={14}/></button><span>Проверьте условия и незаполненные поля перед подписанием.</span></div></div>
   <aside className="review-aside"><div className="review-tabs">{[['review','Проверка'],['history','Версии'],['context','Контекст']].map(([k,t])=><button key={k} className={tab===k?'active':''} onClick={()=>setTab(k as typeof tab)}>{t}{k==='review'&&<span>{doc.issues.filter(i=>i.severity!=='info').length}</span>}</button>)}</div>
    {tab==='review'&&<><div className="review-summary"><span className="review-circle"><ShieldCheck size={25}/></span><h3>{doc.stage==='final'?'Итоговая версия сохранена':doc.issues.some(i=>i.severity!=='info')?'Осталось уточнить детали':'Текст готов к просмотру'}</h3><p>{doc.engine==='ai'?'ИИ проверил текст. Просмотрите замечания и подтвердите итоговую версию.':'Проверена заполненность разделов. Юридические риски и противоречия без ИИ не оценивались.'}</p></div>{!doc.reviewedAt&&<div className="warning-small">После изменения текста запустите проверку заново.</div>}<div className="issue-list">{doc.issues.map((issue,i)=><div className={`issue ${issue.severity}`} key={`${issue.id}-${i}`}><div className="issue-title"><span/>{issue.title}</div><p>{issue.detail}</p>{issue.source&&<small>Источник: {issue.source}</small>}{issue.sectionId&&<button className="text-button" onClick={()=>document.getElementById(`section-${issue.sectionId}`)?.scrollIntoView({behavior:'smooth',block:'center'})}>К разделу<ArrowUpRight size={13}/></button>}</div>)}</div>
    {doc.stage!=='final'&&<>{!demo&&doc.billing?.state==='paid'&&<p className="ai-allowance" role="status">Осталось ИИ-операций: <strong>{doc.billing.aiRemaining} из 2</strong>. Правки и повторные проверки учитываются вместе. Ручные правки и скачивание без ограничений.</p>}<button className="button secondary full" disabled={!!busy||edit||Boolean(state?.ai&&aiExhausted)} onClick={()=>action('review')}><RefreshCw size={16}/>{state?.ai&&!demo?'Проверить с ИИ':'Проверить заполненность'}</button>{state?.ai&&!demo&&<form className="revision-input" onSubmit={e=>{e.preventDefault();if(message.trim())action('revise',{text:message.trim()})}}><label>Уточните условия</label><textarea rows={3} maxLength={12000} placeholder="Например: оплата полностью после приёмки" value={message} onChange={e=>setMessage(e.target.value)}/><button className="button secondary full" disabled={!!busy||edit||aiExhausted||!message.trim()}><Sparkles size={15}/>Внести правки с ИИ</button></form>}<button className="button primary full finish" disabled={!!busy||edit} onClick={()=>setConfirm('finalize')}>Сохранить итоговую версию<Check size={16}/></button></>}{doc.stage==='final'&&<><button className="button primary full" onClick={()=>exportDoc('docx')}><Download size={16}/>Скачать Word</button><button className="text-button reopen" disabled={!!busy} onClick={()=>action('reopen')}>Вернуться к редактированию</button></>}
    </>}
    {tab==='history'&&<div className="history-panel"><h3>Каждое изменение сохранено</h3><p className="muted">Предыдущие версии можно просмотреть и восстановить.</p>{doc.versions.slice().reverse().map(v=><div className="version" key={v.number}><span className="version-number">{v.number}</span><div><strong>{v.label}</strong><small>{new Date(v.at).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</small><div><button className="text-button" onClick={()=>setPreviewVersion(v.number)}>Посмотреть</button>{v.number!==doc.versions.at(-1)?.number&&<button className="text-button" disabled={!!busy||edit} onClick={()=>action('restore',{version:v.number})}>Восстановить</button>}</div></div></div>)}</div>}
    {tab==='context'&&<div className="context-panel"><h3>Исходные условия</h3><dl>{Object.entries(doc.facts).filter(([,v])=>v).map(([k,v])=><div key={k}><dt>{fields(doc.kind).find(f=>f.key===k)?.label||k}</dt><dd>{v}</dd></div>)}</dl>{doc.context&&<><h4>Особые пожелания</h4><p>{doc.context}</p></>}{doc.messages.filter(m=>m.role==='user').length>0&&<><h4>Ответы в интервью</h4>{doc.messages.filter(m=>m.role==='user').map(m=><p key={m.id}>{m.text}</p>)}</>}<div className="aside-note"><p>Здесь собраны сведения, на основе которых подготовлен договор. Сверьте их с вашими договорённостями.</p></div></div>}
   </aside></div>}
  </div>}
  {view==='settings'&&<div className="page settings-page"><div className="eyebrow">ВАШЕ ПРОСТРАНСТВО</div><h1>Аккаунт</h1><p className="lead">Вход, восстановление доступа и условия работы с договором.</p><div className="setting-card"><div className="setting-icon"><ShieldCheck/></div><div><h3>Аккаунт и сохранение</h3><p>{state?.user?state.user.email:'Для сохранения документов войдите по email и паролю.'}</p><p className="muted">Документы и история принадлежат вашему аккаунту.</p>{state?.user&&<a className="text-button" href="/auth">Подтверждение email и восстановление доступа</a>}</div>{state?.user?<a className="button secondary" href="/auth?logout=1" target="_top"><LogOut size={16}/>Выйти</a>:<button className="button primary" onClick={openAuth}>Вход / Регистрация<ArrowRight size={16}/></button>}</div><div className="setting-card"><div className="setting-icon"><FileText/></div><div><h3>Что входит в подготовку договора</h3><p>Уточнение условий → подготовка черновика → проверка и правки → скачивание в Word.</p><p className="muted">Интервью бесплатно. Получение черновика — 199 ₽, включая две ИИ-операции после оплаты. Ручное редактирование и скачивание входят в стоимость.</p></div></div></div>}
 </main>
 {toast&&<div className="toast" role="status"><CheckCircle2 size={18}/>{toast}</div>}
 {busy&&<div className="busy-indicator" role="status"><LoaderCircle className="spin" size={18}/>{busy}…</div>}
 {authOpen&&<AuthDialog onClose={()=>setAuthOpen(false)} onAuthenticated={async()=>{await load();setAuthRequired(false);setAuthOpen(false)}}/>}
 {newKind&&<div className="modal-overlay" onClick={()=>!busy&&setNewKind(null)}><div className="modal" role="dialog" aria-modal="true" aria-label="Новый договор" onClick={e=>e.stopPropagation()}><button className="modal-close icon-button" aria-label="Закрыть" onClick={()=>setNewKind(null)}><X size={21}/></button><div className="eyebrow">НОВАЯ ДОГОВОРЁННОСТЬ</div><h2>Что будем оформлять?</h2><p className="muted">Выберите тип — мы подстроим вопросы и структуру.</p><div className="modal-kind-grid">{KINDS.map(k=>{const Icon=kindIcon[k.id];return <button key={k.id} className={newKind===k.id?'active':''} onClick={()=>setNewKind(k.id)}><Icon size={20}/><span><strong>{k.name}</strong><small>{k.description}</small></span>{newKind===k.id&&<Check size={16}/>}</button>})}</div><label className="field"><span>Название документа <small>необязательно</small></span><input maxLength={160} placeholder="Например, дизайн сайта для «Севера»" value={newTitle} onChange={e=>setNewTitle(e.target.value)}/></label><div className="mode-options"><button className={newMode==='form'?'active':''} onClick={()=>setNewMode('form')}><Pencil size={17}/><span>Заполнить анкету<small>{state?.ai?'Укажите условия в удобных полях':'Без ИИ · базовая структура'}</small></span></button><button className={newMode==='ai'?'active':''} disabled={!state?.ai} onClick={()=>setNewMode('ai')}><Sparkles size={17}/><span>Интервью с ИИ<small>{state?.ai?'Вопросы под вашу задачу':'Сейчас недоступно'}</small></span></button></div>{!state?.user?<div className="sign-in-box"><p>Войдите, чтобы создать договор и сохранить историю.</p><button className="button primary full" onClick={()=>{setNewKind(null);openAuth()}}>Вход / Регистрация<ArrowRight size={16}/></button><button className="text-button" onClick={()=>{setNewKind(null);openDocument('example')}}>Пока посмотреть пример</button></div>:<button className="button primary full" disabled={!!busy} onClick={create}>Начать {newMode==='ai'?'интервью':'составление'}<ArrowRight size={17}/></button>}<p className="modal-foot">Интервью бесплатно. Черновик и полный текст — 199 ₽, включая две ИИ-операции. Оплата после интервью, перед получением черновика.</p></div></div>}
 {confirm&&doc&&<div className="modal-overlay"><div className="modal compact" role="dialog" aria-modal="true" aria-label={confirm==='delete'?'Удалить документ':'Сохранить итоговую версию'}><h2>{confirm==='delete'?'Удалить документ?':'Сохранить как итоговый?'}</h2><p>{confirm==='delete'?'Документ и все его версии будут удалены. Это действие нельзя отменить.':'Итоговый статус фиксирует выбранную вами версию. Он не означает, что договор юридически проверен или готов к подписанию.'}</p>{confirm==='finalize'&&doc.issues.some(i=>i.severity!=='info')&&<div className="warning-small">Остались замечания: {doc.issues.filter(i=>i.severity!=='info').length}. Незаполненные поля сохранятся в документе.</div>}<div className="modal-buttons"><button className="button secondary" disabled={!!busy} onClick={()=>setConfirm(null)}>Отмена</button><button className={`button ${confirm==='delete'?'danger':'primary'}`} disabled={!!busy} onClick={()=>action(confirm,{acknowledge:true})}>{confirm==='delete'?'Удалить':'Просмотрел, сохранить'}</button></div></div></div>}
 </div>
}
