import type { Contract, Section } from './domain.ts';
export function sectionHeading(section:Section){return section.id==='parties'?'':section.title}
export function partyNames(doc:Contract){
 const forms:Record<string,string>={'ООО':'Общество с ограниченной ответственностью','ИП':'Индивидуальный предприниматель','АО':'Акционерное общество','ПАО':'Публичное акционерное общество'};
 const names=[doc.facts.partyA,doc.facts.partyB].filter(Boolean).map(s=>s.split(/,?\s+(?:в лице|в интересах|представител[ья])\s+/i)[0].trim()).filter(s=>s.length>1);
 return [...new Set(names.flatMap(s=>{const expanded=s.replace(/^(ООО|ИП|ПАО|АО)\s+/i,(_,opf)=>forms[opf.toUpperCase()]+' ');return [s,expanded].flatMap(n=>[n,n.replace(/"([^"\n]+)"/g,'«$1»'),n.replace(/«([^»]+)»/g,'"$1"')])}))].sort((a,b)=>b.length-a.length);
}
export function textRuns(text:string,doc:Contract,sectionId:string):{text:string;bold:boolean;missing:boolean}[]{
 const names=['parties','details'].includes(sectionId)?partyNames(doc):[];
 const escaped=names.map(n=>n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
 const regex=new RegExp('(<[^<>\\n]+>|\\[[^\\]\\n]+\\]'+(escaped.length?'|'+escaped.join('|'):'')+')','gi');
 return text.split(regex).filter(Boolean).map(part=>({text:part,bold:names.some(n=>n.toLowerCase()===part.toLowerCase()),missing:/^(?:<[^>]+>|\[[^\]]+\])$/.test(part)}));
}
