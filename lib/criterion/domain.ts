export function uid(){ if(typeof crypto.randomUUID==='function')return crypto.randomUUID();const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=Array.from(b,n=>n.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`; }
export const KINDS = [
  {id:'services',name:'Оказание услуг',short:'Услуги',description:'Консалтинг, дизайн, маркетинг и другие услуги',icon:'briefcase'},
  {id:'sale',name:'Купля-продажа',short:'Купля-продажа',description:'Передача товара и порядок расчётов',icon:'package'},
  {id:'lease',name:'Аренда',short:'Аренда',description:'Помещение, оборудование или другое имущество',icon:'key'},
  {id:'work',name:'Подряд',short:'Подряд',description:'Работы с конкретным результатом',icon:'hammer'},
  {id:'nda',name:'Конфиденциальность',short:'NDA',description:'Условия передачи и защиты информации',icon:'shield'},
  {id:'other',name:'Другая договорённость',short:'Другое',description:'Опишите вашу ситуацию своими словами',icon:'file'},
] as const;
export type Kind = typeof KINDS[number]['id'];
export type Facts = Record<string,string>;
export type Message = {id:string;role:'assistant'|'user';text:string;at:string};
export type Section = {id:string;title:string;content:string};
export type Issue = {id:string;severity:'high'|'medium'|'info';title:string;detail:string;sectionId?:string;source?:string};
export type Version = {number:number;at:string;label:string;sections:Section[];issues:Issue[]};
export type Contract = {id:string;title:string;kind:Kind;stage:'interview'|'ready'|'review'|'final';mode:'form'|'ai';revision:number;createdAt:string;updatedAt:string;facts:Facts;context:string;messages:Message[];sections:Section[];issues:Issue[];versions:Version[];materialsSnapshot?:Materials;engine?:'template'|'ai';reviewedAt?:string;billing?:import('./billing').Billing};
export type Materials = {prompt:string;template:string;sources:string;updatedAt?:string};
export const EMPTY_MATERIALS:Materials={prompt:'',template:'',sources:''};
export const SECTIONS = [
  {id:'parties',title:'Стороны договора'},{id:'subject',title:'Предмет договора'},
  {id:'duties',title:'Права и обязанности сторон'},{id:'payment',title:'Цена и порядок расчётов'},
  {id:'term',title:'Сроки и порядок исполнения'},{id:'acceptance',title:'Передача и приёмка'},
  {id:'liability',title:'Ответственность сторон'},{id:'force',title:'Обстоятельства непреодолимой силы'},
  {id:'disputes',title:'Разрешение споров'},{id:'termination',title:'Изменение и прекращение договора'},
  {id:'other',title:'Прочие условия'},{id:'details',title:'Реквизиты и подписи'},
];
export function fields(kind:Kind){
 const names = kind==='lease'?['Арендодатель','Арендатор','Что передаётся в аренду?','Арендная плата','Как передаётся и возвращается имущество?']:kind==='sale'?['Продавец','Покупатель','Какой товар передаётся?','Стоимость товара','Когда и как передаётся товар?']:kind==='work'?['Подрядчик','Заказчик','Какие работы и какой результат?','Стоимость работ','Как принимается результат работы?']:kind==='nda'?['Передающая сторона','Получающая сторона','Какая информация передаётся?','Платежи, если предусмотрены','Как и кому передаётся информация?']:['Исполнитель','Заказчик','Какие услуги нужно оказать?','Стоимость услуг','Как подтверждается оказание услуг?'];
 return [
 {key:'partyA',label:names[0],placeholder:'ФИО или название организации',group:0},
 {key:'partyB',label:names[1],placeholder:'ФИО или название организации',group:0},
 {key:'subject',label:names[2],placeholder:'Опишите договорённость простыми словами',group:0},
 {key:'price',label:names[3],placeholder:'Например, 80 000 рублей',group:1},
 {key:'payment',label:'Когда и как производится оплата?',placeholder:'Например, 50% аванс, 50% после приёмки',group:1},
 {key:'term',label:'Сроки и даты',placeholder:'Дата начала, окончания или срок действия',group:1},
 {key:'acceptance',label:names[4],placeholder:'Порядок, срок проверки, документ о приёмке',group:2},
 {key:'liability',label:'Что договорились о нарушении условий?',placeholder:'Неустойка, убытки или оставить для согласования',group:2},
 {key:'termination',label:'Как можно прекратить договор?',placeholder:'Срок уведомления, расчёты при прекращении',group:2},
 {key:'city',label:'Место заключения',placeholder:'Город',group:3},
 {key:'date',label:'Дата договора',placeholder:'ДД.ММ.ГГГГ',group:3},
 {key:'detailsA',label:'Реквизиты первой стороны',placeholder:'Адрес, ИНН, контакт и банковские реквизиты',group:3},
 {key:'detailsB',label:'Реквизиты второй стороны',placeholder:'Адрес, ИНН, контакт и банковские реквизиты',group:3},
 ];
}
export function titleFor(kind:Kind){return kind==='nda'?'Соглашение о конфиденциальности':kind==='other'?'Договор':`Договор ${kind==='services'?'оказания услуг':kind==='sale'?'купли-продажи':kind==='lease'?'аренды':'подряда'}`}
export function makeContract(kind:Kind,mode:'form'|'ai',title?:string):Contract{
 const at=new Date().toISOString();
 return {id:uid(),title:title?.trim()||titleFor(kind),kind,stage:'interview',mode,revision:0,createdAt:at,updatedAt:at,facts:{},context:'',messages:[{id:uid(),role:'assistant',text:'Расскажите, какую договорённость хотите оформить: кто с кем и о чём договаривается? Можно использовать вымышленные данные. Добавьте всё, что считаете важным.',at}],sections:[],issues:[],versions:[]};
}
const blank=(_name:string)=>`<…>`;
export function draftTemplate(doc:Contract):Section[]{
 const f=doc.facts,v=(key:string,name:string)=>f[key]?.trim().replace(/[.!?]+$/,'')||blank(name), role=fields(doc.kind);
 const subjectIntro=doc.kind==='sale'?'Продавец передаёт в собственность Покупателя, а Покупатель принимает и оплачивает следующий товар':doc.kind==='lease'?'Арендодатель передаёт Арендатору во временное владение и пользование следующее имущество':doc.kind==='work'?'Подрядчик выполняет для Заказчика следующие работы и передаёт их результат':doc.kind==='nda'?'Стороны устанавливают условия передачи и использования следующей конфиденциальной информации':doc.kind==='other'?'Стороны договорились о следующем':'Исполнитель оказывает Заказчику следующие услуги';
 const values:Record<string,string>={
  parties:`${v('city','город')}, ${v('date','дата заключения')}.\n${role[0].label}: ${v('partyA','первая сторона')}.\n${role[1].label}: ${v('partyB','вторая сторона')}.\nСтороны заключили настоящий договор на изложенных ниже условиях.`,
  subject:`${subjectIntro}: ${v('subject','описание предмета договора')}.`,
  duties:doc.kind==='nda'?`${blank('круг допущенных лиц, разрешённые цели использования, меры защиты и исключения из конфиденциальности')}.`:`Стороны исполняют согласованные обязательства в порядке и сроки, установленные настоящим договором.\n${blank('конкретные обязанности, необходимые материалы и содействие сторон')}.`,
  payment:`${doc.kind==='lease'?'Арендная плата':doc.kind==='nda'?'Платежи по соглашению':'Цена договора'}: ${v('price','сумма, валюта, налоги или отсутствие платы')}.\nПорядок расчётов: ${v('payment','способ, сроки и условия оплаты')}.`,
  term:`Сроки исполнения обязательств: ${v('term','даты и сроки исполнения')}.\n${blank('срок действия договора, если отличается от сроков исполнения')}.`,
  acceptance:`Порядок передачи и приёмки: ${v('acceptance','порядок передачи, проверки и оформления приёмки')}.`,
  liability:`Согласованные условия ответственности: ${v('liability','условия ответственности; неустойка при её согласовании')}.`,
  force:`${blank('условия освобождения от ответственности при непреодолимой силе, порядок уведомления и последствия длительного препятствия')}.`,
  disputes:`${blank('порядок урегулирования разногласий, срок ответа на претензию и допустимые условия подсудности')}.`,
  termination:`Изменение и прекращение договора: ${v('termination','основания, порядок уведомления и окончательных расчётов')}.`,
  other:`${blank('способы юридически значимого обмена сообщениями и перечень приложений')}.`,
  details:`${role[0].label}: ${v('partyA','первая сторона')}.\n${v('detailsA','адрес и реквизиты первой стороны')}.\nПодпись: ____________________\n\n${role[1].label}: ${v('partyB','вторая сторона')}.\n${v('detailsB','адрес и реквизиты второй стороны')}.\nПодпись: ____________________`,
 };
 return SECTIONS.map(s=>({...s,content:values[s.id]}));
}
export function review(doc:Contract):Issue[]{
 const issues:Issue[]=[];
 for(const s of doc.sections){
  const missing=[...s.content.matchAll(/\[УТОЧНИТЬ:\s*([^\]]+)\]|<([^<>\n]+)>/g)].map(m=>m[1]||((m[2]==='…'||m[2]==='...')?'Не заполнены сведения':m[2]));
  const alternatives=[...s.content.matchAll(/\[([^\]\n]*\/[^\]\n]*)\]/g)].map(m=>m[1]);
  if(alternatives.length)issues.push({id:`alternatives-${s.id}`,severity:'medium',title:`Выбрать условия: ${s.title.toLowerCase()}`,detail:alternatives.join('; '),sectionId:s.id});
  if(missing.length)issues.push({id:`missing-${s.id}`,severity:['parties','subject','payment','term'].includes(s.id)?'high':'medium',title:`Уточнить: ${s.title.toLowerCase()}`,detail:missing.join('; '),sectionId:s.id});
  if(!s.content.trim())issues.push({id:`empty-${s.id}`,severity:'high',title:`Пустой раздел: ${s.title}`,detail:'Раздел нужно заполнить или осознанно исключить в редакторе.',sectionId:s.id});
 }
 if(doc.engine==='template')issues.push({id:'template',severity:'info',title:'Собран по базовой структуре',detail:'Это структурированный черновик. Свободный контекст не интерпретирован автоматически; проверьте его при редактировании. Юридическая оценка и поиск противоречий требуют ИИ и проверки специалистом.'});
 if(!doc.materialsSnapshot?.sources)issues.push({id:'sources',severity:'info',title:'Правовой пакет не подключён',detail:'Проверка актуальности законодательства не выполнялась. Загрузите проверенные источники в «Материалы».'});
 if(doc.context.trim() && doc.engine==='template')issues.push({id:'context',severity:'medium',title:'Есть дополнительные пожелания',detail:doc.context});
 return issues;
}
export function snapshot(doc:Contract,label:string){
 return {number:(doc.versions.at(-1)?.number||0)+1,at:new Date().toISOString(),label,sections:structuredClone(doc.sections),issues:structuredClone(doc.issues)};
}
export function documentText(doc:Contract){return `${doc.title}\n\n${doc.sections.map(s=>`${s.id==='parties'?'':s.title+'\n\n'}${s.content}`).join('\n\n')}\n`}
export function demoContract():Contract{
 const doc=makeContract('services','form','Разработка фирменного стиля');doc.id='example';
 doc.facts={partyA:'ИП Анна Смирнова',partyB:'ООО «Север»',subject:'Разработка логотипа, цветовой палитры и руководства по использованию фирменного стиля. Два варианта концепции и два раунда правок.',price:'80 000 рублей',payment:'40 000 рублей авансом до начала работ; 40 000 рублей в течение 5 рабочих дней после подписания акта оказанных услуг. Перечисление на расчётный счёт Исполнителя.',term:'С 1 ноября по 30 ноября 2026 года',acceptance:'Исполнитель направляет результаты и акт по электронной почте. Заказчик в течение 5 рабочих дней подписывает акт либо направляет перечень конкретных недостатков.',liability:'За просрочку оплаты — 0,1% от просроченной суммы за каждый день просрочки, но не более 10% этой суммы.',city:'Москва',date:'01.11.2026'};
 doc.engine='template';doc.stage='review';doc.reviewedAt=new Date().toISOString();doc.sections=draftTemplate(doc);doc.issues=review(doc);doc.versions=[snapshot(doc,'Первый черновик')];return doc;
}
