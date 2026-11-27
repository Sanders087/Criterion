import {env} from '../../../../../lib/runtime';
import {identity,failure,HttpError} from '../../../../../lib/criterion/server';
import {getServiceOrder,isOrderOperator,presentOrder} from '../../../../../lib/criterion/service-orders';
import {docx} from '../../../../../lib/criterion/export';
export async function GET(_req:Request,context:{params:Promise<{id:string}>}){try{
 const user=await identity();if(!isOrderOperator(user.userId))throw new HttpError(403,'Недостаточно прав.');
 const order=await getServiceOrder((await context.params).id,user.userId,true);if(!presentOrder(order).paid)throw new HttpError(409,'Заказ не оплачен.');
 const doc=await env.DB.prepare('SELECT body FROM documents WHERE id=? AND owner=?').bind(order.document_id,order.owner).first<{body:string}>();
 if(!doc)throw new HttpError(404,'Документ не найден.');
 return new Response(docx(JSON.parse(doc.body)) as BodyInit,{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','Content-Disposition':'attachment; filename="Criterion.docx"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}catch(e){return failure(e)}}
