import {env} from '../../../lib/runtime';
import {identity,json,failure,HttpError} from '../../../lib/criterion/server';
import {isOrderOperator,presentOrder,type OrderRow} from '../../../lib/criterion/service-orders';
export async function GET(){try{
 const user=await identity();if(!isOrderOperator(user.userId))throw new HttpError(403,'Этот раздел доступен ответственному за заказы.');
 const result=await env.DB.prepare("SELECT p.id,p.document_id,p.owner,p.status,p.amount,p.package_snapshot,(p.signature_file IS NOT NULL) AS signature_file,p.video_url,p.consultation_at,p.consultation_timezone,p.meeting_url,p.consultation_status,p.fulfillment_revision,d.title AS document_title,a.email FROM payment_orders p LEFT JOIN documents d ON d.id=p.document_id LEFT JOIN accounts a ON a.id=p.owner WHERE p.status IN ('CONFIRMED','PARTIAL_REFUNDED','REFUNDED') AND json_extract(p.package_snapshot,'$.signature')=1 ORDER BY p.created_at DESC").all();
 return json({orders:result.results.map((row:OrderRow&{email:string;document_title:string})=>({...presentOrder(row),email:row.email,title:row.document_title}))});
}catch(e){return failure(e)}}
