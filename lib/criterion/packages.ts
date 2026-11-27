export const PACKAGE_IDS = ['contract', 'video', 'consultation'] as const;
export type PackageId = typeof PACKAGE_IDS[number];
export type PackageDefinition = {id:PackageId; name:string; amount:number; purpose:string; signature:boolean; video:boolean; consultationMinutes:number; description:string[]; extras:string[]};
export const PACKAGES:PackageDefinition[] = [
  {id:'contract',name:'Договор',amount:19900,purpose:'Мне нужен готовый документ',signature:false,video:false,consultationMinutes:0,
    description:['Вы рассказываете о своей договорённости, а Критерион автоматически готовит договор с учётом её условий.','В основе документа — моя юридическая практика и проверенные годами шаблоны. Я лично отвечаю за юридическую методологию, на которой работает Критерион.','Вы получаете договор, который закрепляет обязательства сторон и может использоваться для защиты ваших прав в суде, а также для подтверждения договорённостей перед государственными органами и коммерческими организациями.'],
    extras:['Подготовка договора под вашу ситуацию на основе шаблонов из моей практики.','Закрепление условий, которые вы указали в ходе интервью.','Готовый документ для согласования с контрагентом и подписания.']},
  {id:'video',name:'Договор с видеоразбором',amount:99900,purpose:'Хочу понимать, что обсудить с контрагентом и какие риски учитывать',signature:true,video:true,consultationMinutes:0,
    description:['Вы получаете подготовленный Критерионом договор с моей подписью и персональный видеоразбор.','В видео я объясню, какие условия стоит отдельно обсудить с контрагентом, что проверить перед подписанием и какие риски держать в уме в ходе сотрудничества. Договор помогает защитить ваши интересы, но многое зависит и от того, как стороны действуют на практике.'],
    extras:['Моя подпись на договоре.','Персональное видео с пояснениями по вашей ситуации.','Разбор основных рисков и условий, требующих особого внимания.','Рекомендации по вопросам, которые стоит заранее обсудить с контрагентом.']},
  {id:'consultation',name:'Договор с персональной консультацией',amount:399900,purpose:'Хочу обсудить свою ситуацию с юристом и задать вопросы',signature:true,video:false,consultationMinutes:60,
    description:['Вы получаете подготовленный Критерионом договор с моей подписью, а также индивидуальную консультацию продолжительностью 60 минут.','На встрече мы подробно обсудим вашу ситуацию и условия договора. Вы сможете задать вопросы, объяснить свои опасения и получить рекомендации по переговорам с контрагентом и дальнейшим действиям.'],
    extras:['Моя подпись на договоре.','Личная консультация продолжительностью 60 минут.','Подробный разбор договора и связанных с ним рисков.','Ответы на ваши вопросы и практические рекомендации.']},
];
export const PACKAGE_INTRO='Критерион создаёт договоры на основе шаблонов, которые я использовал и совершенствовал более десяти лет ежедневной юридической практики. Эти шаблоны содержат необходимые условия для закрепления договорённостей и адаптируются под вашу ситуацию на основании ваших ответов.';
export const packageById=(id:unknown)=>PACKAGES.find(p=>p.id===id);
export const rubles=(amount:number)=>new Intl.NumberFormat('ru-RU').format(amount/100)+' ₽';
export function packageContents(p:Pick<PackageDefinition,'signature'|'video'|'consultationMinutes'>){return ['Договор под вашу ситуацию',...(p.signature?['Подпись Андрея Витько']:[]),...(p.video?['Персональный видеоразбор']:[]),...(p.consultationMinutes?[`Индивидуальная консультация, ${p.consultationMinutes} минут`]:[])];}
export type PackageTerms={available:boolean;terms:string[]};
export type PackageAvailability=Record<PackageId,PackageTerms>;
export type OrderSnapshot={id:PackageId;name:string;amount:number;signature:boolean;video:boolean;consultationMinutes:number;contents:string[];terms:string[]};
export type ServiceOrder={id:string;documentId:string;paymentStatus:string;paid:boolean;snapshot:OrderSnapshot;signatureReady:boolean;videoUrl:string|null;consultationAt:string|null;timezone:string|null;meetingUrl:string|null;consultationStatus:string;complete:boolean;version:number};
