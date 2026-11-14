import { z } from 'zod';
import { and,eq,or,isNull,lt,sql } from 'drizzle-orm';
import { getDb } from '../../../../db';
import { documents } from '../../../../db/schema';
import { identity,json,failure,readBody,runtime,getMaterials,unpack,HttpError } from '../../../../lib/criterion/server';
import { draftTemplate,review,snapshot,fields,type Contract } from '../../../../lib/criterion/domain';
import { interview,generate,mergeFacts,reviewAI } from '../../../../lib/criterion/ai';
import { presentContract,hasAccess,INCLUDED_AI_OPERATIONS } from '../../../../lib/criterion/billing';
const schema=z.object({action:z.enum(['save','message','generate','revise','edit','review','finalize','reopen','restore','delete']),revision:z.number().int().nonnegative(),facts:z.record(z.string().max(6000)).optional(),context:z.string().max(15000).optional(),text:z.string().min(1).max(12000).optional(),title:z.string().min(1).max(160).optional(),sections:z.array(z.object({id:z.string().min(1).max(100),title:z.string().min(1).max(200),content:z.string().max(18000)})).min(3).max(30).optional(),version:z.number().int().positive().optional(),acknowledge:z.boolean().optional()});
type Context={params:Promise<{id:string}>};
export async function GET(_req:Request,context:Context){try{const user=await identity();const {id}=await context.params;const [row]=await getDb().select().from(documents).where(and(eq(documents.id,id),eq(documents.owner,user.userId)));if(!row)throw new HttpError(404,'Документ не найден.');return json(presentContract(row))}catch(e){return failure(e)}}
export async function PATCH(req:Request,context:Context){let lockToken:string|undefined;let id='';let owner='';try{
 const user=await identity();owner=user.userId;id=(await context.params).id;const data=schema.parse(await readBody(req));const db=getDb();
 const [row]=await db.select().from(documents).where(and(eq(documents.id,id),eq(documents.owner,owner)));if(!row)throw new HttpError(404,'Документ не найден.');
 if(row.revision!==data.revision)throw new HttpError(409,'Документ изменён в другой вкладке. Откройте его заново, чтобы не потерять изменения.');
 const now=Date.now();lockToken=crypto.randomUUID();
 const claimed=await db.update(documents).set({lockToken,lockUntil:now+180000}).where(and(eq(documents.id,id),eq(documents.owner,owner),eq(documents.revision,data.revision),or(isNull(documents.lockUntil),lt(documents.lockUntil,now)))).returning({id:documents.id});
 if(!claimed.length)throw new HttpError(409,'Предыдущее действие ещё выполняется. Подождите и повторите.');
 if(data.action==='delete'){
  const deleted=await db.delete(documents).where(and(eq(documents.id,id),eq(documents.owner,owner),eq(documents.lockToken,lockToken),sql`NOT EXISTS (SELECT 1 FROM payment_orders WHERE active_document=${id} AND status NOT IN ('CONFIRMED','PARTIAL_REFUNDED','REFUNDED'))`)).returning({id:documents.id});
  if(!deleted.length)throw new HttpError(409,'Сначала завершите оплату или дождитесь её отмены. Договор сохранён.');return json({deleted:true});
 }
 let doc:Contract=unpack(row);
 if(doc.sections.length&&!hasAccess(row.billingState))throw new HttpError(402,'Оплатите договор, чтобы открыть полный текст, редактирование и скачивание.');
 const usesPaidAI=row.billingState!=='legacy'&&(data.action==='revise'||(data.action==='review'&&Boolean(runtime().OPENAI_API_KEY)));
 if(usesPaidAI&&row.aiOperationsUsed>=INCLUDED_AI_OPERATIONS)throw new HttpError(402,'Две включённые ИИ-операции использованы. Ручное редактирование и скачивание остаются доступны.');
 if(doc.stage==='final'&&!['reopen','restore'].includes(data.action))throw new HttpError(409,'Сначала верните итоговый документ в редактирование.');
 if(['generate','message','save'].includes(data.action)&&!['interview','ready'].includes(doc.stage))throw new HttpError(409,'Этот этап уже завершён. Редактируйте готовый черновик.');
 if(data.facts){const keys=new Set(fields(doc.kind).map(f=>f.key));if(Object.keys(data.facts).some(k=>!keys.has(k)))throw new HttpError(400,'Неизвестное поле анкеты.');doc.facts={...doc.facts,...data.facts}}
 if(data.context!==undefined)doc.context=data.context;if(data.title)doc.title=data.title;
 const at=new Date().toISOString();const materials=doc.materialsSnapshot||await getMaterials(owner);
 if(data.action==='message'){
  if(doc.mode!=='ai'||!data.text)throw new HttpError(400,'Сообщения доступны в режиме ИИ-интервью.');
  if(doc.messages.length>=80)throw new HttpError(400,'Интервью достигло лимита. Перейдите к черновику.');
  doc.messages.push({id:crypto.randomUUID(),role:'user',text:data.text,at});const reply=await interview(runtime(),doc,materials);doc.facts=mergeFacts(doc,reply.facts);doc.stage=reply.ready?'ready':'interview';doc.messages.push({id:crypto.randomUUID(),role:'assistant',text:reply.reply,at});
 }
 if(data.action==='generate'){
  doc.materialsSnapshot=materials;
  if(doc.mode==='ai'||Boolean(runtime().OPENAI_API_KEY)){const result=await generate(runtime(),doc,materials);doc.sections=result.sections;doc.engine='ai';doc.issues=[...result.issues,...review(doc)];}
  else{if(materials.template.trim())throw new HttpError(400,'Авторский шаблон подключён. Для его применения нужен ИИ. Базовая анкета не будет подменять этот шаблон.');doc.sections=draftTemplate(doc);doc.engine='template';doc.issues=review(doc)}
  doc.stage='review';doc.reviewedAt=at;doc.versions.push(snapshot(doc,'Первый черновик'));
 }
 if(['edit','revise','review','finalize'].includes(data.action)&&!doc.sections.length)throw new HttpError(400,'Сначала создайте черновик.');
 if(data.action==='edit'){
  if(!data.sections)throw new HttpError(400,'Нет текста для сохранения.');
  if(new Set(data.sections.map(s=>s.id)).size!==data.sections.length)throw new HttpError(400,'Разделы должны иметь уникальные id.');
  doc.sections=data.sections;doc.issues=review(doc);doc.reviewedAt=undefined;doc.versions.push(snapshot(doc,'Ручные правки'));doc.stage='review';
 }
 if(data.action==='revise'){
  if(!data.text)throw new HttpError(400,'Опишите изменение.');
  const result=await generate(runtime(),doc,materials,data.text);doc.sections=result.sections;doc.engine='ai';doc.messages.push({id:crypto.randomUUID(),role:'user',text:'Правка: '+data.text,at});doc.issues=[...result.issues,...review(doc)];doc.reviewedAt=at;doc.versions.push(snapshot(doc,'Правка по запросу'));doc.stage='review';
 }
 if(data.action==='review'){
  doc.issues=review(doc);if(runtime().OPENAI_API_KEY)doc.issues=[...await reviewAI(runtime(),doc,materials),...doc.issues];doc.reviewedAt=at;doc.versions.push(snapshot(doc,runtime().OPENAI_API_KEY?'ИИ-проверка':'Проверка заполненности'));
 }
 if(data.action==='finalize'){
  if(!data.acknowledge)throw new HttpError(400,'Подтвердите, что просмотрели текст и замечания.');
  doc.stage='final';doc.versions.push(snapshot(doc,'Итоговая версия'));
 }
 if(data.action==='reopen')doc.stage='review';
 if(data.action==='restore'){
  const version=doc.versions.find(v=>v.number===data.version);if(!version)throw new HttpError(404,'Версия не найдена.');doc.sections=structuredClone(version.sections);doc.issues=review(doc);doc.reviewedAt=undefined;doc.stage='review';doc.versions.push(snapshot(doc,`Восстановлена версия ${version.number}`));
 }
 if(doc.versions.length>80)throw new HttpError(400,'Достигнут лимит 80 версий. Скачайте документ и создайте новую сессию.');
 doc.updatedAt=at;doc.revision=data.revision+1;
 const saved=await db.update(documents).set({body:JSON.stringify(doc),title:doc.title,stage:doc.stage,revision:doc.revision,updatedAt:at,lockToken:null,lockUntil:null,...(usesPaidAI?{aiOperationsUsed:row.aiOperationsUsed+1}:{})}).where(and(eq(documents.id,id),eq(documents.owner,owner),eq(documents.lockToken,lockToken),eq(documents.revision,data.revision),eq(documents.billingState,row.billingState),...(usesPaidAI?[eq(documents.aiOperationsUsed,row.aiOperationsUsed)]:[]))).returning();
 if(!saved.length)throw new HttpError(409,'Документ был обновлён параллельно. Откройте последнюю версию.');
 return json(presentContract(saved[0]));
}catch(e){return failure(e)}finally{if(lockToken&&id&&owner)try{await getDb().update(documents).set({lockToken:null,lockUntil:null}).where(and(eq(documents.id,id),eq(documents.owner,owner),eq(documents.lockToken,lockToken)))}catch{}}}
