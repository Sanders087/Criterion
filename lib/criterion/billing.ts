import type { Contract } from './domain.ts';

export const CONTRACT_PRICE = 19900;
export const INCLUDED_AI_OPERATIONS = 2;
export type Billing = {state:string; locked:boolean; price:number; aiRemaining:number|null};
export type BillingRow = {body:string; revision:number; billingState:string; aiOperationsUsed:number};
export function hasAccess(state:string){return state==='paid'||state==='legacy'}
export function presentContract(row:BillingRow):Contract {
  const doc:Contract={...JSON.parse(row.body),revision:row.revision};
  const locked=!hasAccess(row.billingState)&&doc.sections.length>0;
  doc.billing={state:row.billingState,locked,price:CONTRACT_PRICE,aiRemaining:row.billingState==='legacy'?null:Math.max(0,INCLUDED_AI_OPERATIONS-row.aiOperationsUsed)};
  if(!locked)return doc;
  // No generated text, historic text, review excerpts or material copies reach the browser.
  return {...doc,sections:doc.sections.map(s=>({id:s.id,title:s.title,content:''})),issues:[],versions:[],materialsSnapshot:undefined,reviewedAt:undefined};
}
