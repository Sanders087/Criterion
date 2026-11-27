import {env} from '../../../../../lib/runtime';
import {identity,failure,json,HttpError} from '../../../../../lib/criterion/server';
import {sameOrigin} from '../../../../../lib/criterion/request-security';
import {getServiceOrder,isOrderOperator,presentOrder} from '../../../../../lib/criterion/service-orders';
type Context={params:Promise<{id:string}>};
export async function GET(_req:Request,context:Context){try{
 const user=await identity(),row=await getServiceOrder((await context.params).id,user.userId,isOrderOperator(user.userId));
 if(!presentOrder(row).signatureReady||!row.signature_file)throw new HttpError(404,'Подписанный документ пока не доступен.');
 return new Response(new Uint8Array(row.signature_file),{headers:{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="Criterion-signed.pdf"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}catch(e){return failure(e)}}
export async function PUT(req:Request,context:Context){try{
 const user=await identity();if(!isOrderOperator(user.userId)||!sameOrigin(req))throw new HttpError(403,'Недостаточно прав.');
 const row=await getServiceOrder((await context.params).id,user.userId,true),order=presentOrder(row);
 if(!order.paid||!order.snapshot.signature)throw new HttpError(409,'Подпись недоступна для этого заказа.');
 const version=Number(req.headers.get('x-order-version'));if(!req.headers.has('x-order-version')||!Number.isSafeInteger(version)||version<0)throw new HttpError(400,'Укажите версию заказа.');
 if(req.headers.get('content-type')!=='application/pdf'||!req.body)throw new HttpError(400,'Загрузите подписанный PDF.');
 const reader=req.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>5*1024*1024){await reader.cancel();throw new HttpError(413,'PDF должен быть не больше 5 МБ.');}chunks.push(value);}
 const bytes=Buffer.concat(chunks);if(bytes.subarray(0,5).toString()!=='%PDF-')throw new HttpError(400,'Файл не является PDF.');
 const updated=await env.DB.prepare("UPDATE payment_orders SET signature_file=?,fulfillment_revision=fulfillment_revision+1,updated_at=? WHERE id=? AND fulfillment_revision=? AND status IN ('CONFIRMED','PARTIAL_REFUNDED') RETURNING id").bind(bytes,Date.now(),row.id,version).first();
 if(!updated)throw new HttpError(409,'Заказ изменился. Обновите страницу.');
 await env.DB.prepare('INSERT INTO order_service_events VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),row.id,user.userId,'signature',Date.now()).run();
 return json(presentOrder(await getServiceOrder(row.id,user.userId,true)));
}catch(e){return failure(e)}}
