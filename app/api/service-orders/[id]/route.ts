import {z} from 'zod';
import {env} from '../../../../lib/runtime';
import {identity,json,failure,readBody,HttpError} from '../../../../lib/criterion/server';
import {sameOrigin} from '../../../../lib/criterion/request-security';
import {getServiceOrder,isOrderOperator,presentOrder} from '../../../../lib/criterion/service-orders';
const https=z.string().url().max(2000).refine(v=>{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password},'Нужна HTTPS-ссылка');
const schema=z.discriminatedUnion('action',[
 z.object({action:z.literal('video'),version:z.number().int().nonnegative(),url:https}).strict(),
 z.object({action:z.literal('offer'),version:z.number().int().nonnegative(),at:z.string().datetime({offset:true}),timezone:z.string().min(1).max(100),url:https}).strict(),
 z.object({action:z.literal('accept'),version:z.number().int().nonnegative()}).strict(),
 z.object({action:z.literal('complete'),version:z.number().int().nonnegative()}).strict(),
]);
type Context={params:Promise<{id:string}>};
export async function GET(_req:Request,context:Context){try{const user=await identity();return json(presentOrder(await getServiceOrder((await context.params).id,user.userId,isOrderOperator(user.userId))))}catch(e){return failure(e)}}
export async function PATCH(req:Request,context:Context){try{
 const user=await identity();if(!sameOrigin(req))throw new HttpError(403,'Запрос должен исходить из этого приложения.');
 const data=schema.parse(await readBody(req)),operator=isOrderOperator(user.userId);
 const row=await getServiceOrder((await context.params).id,user.userId,operator),order=presentOrder(row);
 if(!order.paid)throw new HttpError(409,'Заказ не оплачен или оплата возвращена.');
 if(data.action==='accept'?row.owner!==user.userId:!operator)throw new HttpError(403,'Недостаточно прав для этого действия.');
 let sql='',args:unknown[]=[];
 if(data.action==='video'){
   if(!order.snapshot.video)throw new HttpError(409,'Видео не входит в пакет.');
   sql='video_url=?';args=[data.url];
 }else{
   if(!order.snapshot.consultationMinutes)throw new HttpError(409,'Консультация не входит в пакет.');
   if(data.action==='offer'){
     try{new Intl.DateTimeFormat('ru-RU',{timeZone:data.timezone}).format()}catch{throw new HttpError(400,'Укажите часовой пояс IANA, например Europe/Moscow.');}
     if(Date.parse(data.at)<=Date.now()||row.consultation_status==='completed')throw new HttpError(409,'Укажите будущее время для незавершённой консультации.');
     sql="consultation_at=?,consultation_timezone=?,meeting_url=?,consultation_status='offered'";args=[data.at,data.timezone,data.url];
   }else if(data.action==='accept'){
     if(row.consultation_status!=='offered'||Date.parse(row.consultation_at||'')<=Date.now())throw new HttpError(409,'Время уже изменилось или прошло. Нужен новый вариант встречи.');
     sql="consultation_status='scheduled'";
   }else{
     if(row.consultation_status!=='scheduled'||Date.parse(row.consultation_at||'')+3600000>Date.now())throw new HttpError(409,'Консультацию можно завершить после согласованного часа встречи.');
     sql="consultation_status='completed'";
   }
 }
 const updated=await env.DB.prepare(`UPDATE payment_orders SET ${sql},fulfillment_revision=fulfillment_revision+1,updated_at=? WHERE id=? AND fulfillment_revision=? AND status IN ('CONFIRMED','PARTIAL_REFUNDED') RETURNING id`).bind(...args,Date.now(),row.id,data.version).first();
 if(!updated)throw new HttpError(409,'Заказ изменился. Обновите страницу.');
 await env.DB.prepare('INSERT INTO order_service_events VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),row.id,user.userId,data.action,Date.now()).run();
 return json(presentOrder(await getServiceOrder(row.id,user.userId,operator)));
}catch(e){return failure(e)}}
