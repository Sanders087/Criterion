import {and,eq} from 'drizzle-orm';
import {getDb} from '../../../../../db';
import {documents} from '../../../../../db/schema';
import {identity,failure,unpack,HttpError} from '../../../../../lib/criterion/server';
import {documentText} from '../../../../../lib/criterion/domain';
import {docx} from '../../../../../lib/criterion/export';
import {hasAccess} from '../../../../../lib/criterion/billing';
export async function GET(req:Request,context:{params:Promise<{id:string}>}){try{
 const user=await identity();const {id}=await context.params;const format=new URL(req.url).searchParams.get('format')||'docx';if(!['docx','txt'].includes(format))throw new HttpError(400,'Неизвестный формат экспорта.');
 const [row]=await getDb().select().from(documents).where(and(eq(documents.id,id),eq(documents.owner,user.userId)));if(!row)throw new HttpError(404,'Документ не найден.');
 if(!hasAccess(row.billingState))throw new HttpError(402,'Оплатите договор, чтобы скачать полный текст.');
 const doc=unpack(row);if(!doc.sections.length)throw new HttpError(400,'Сначала создайте черновик.');const filename=encodeURIComponent(doc.title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_')+'.'+format);
 return new Response(format==='docx'?docx(doc) as BodyInit:documentText(doc),{headers:{'Content-Type':format==='docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'text/plain;charset=utf-8','Content-Disposition':`attachment; filename="criterion.${format}"; filename*=UTF-8''${filename}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}catch(e){return failure(e)}}
