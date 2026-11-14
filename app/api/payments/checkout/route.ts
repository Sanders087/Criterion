import {z} from 'zod';
import {identity,json,failure,readBody,HttpError} from '../../../../lib/criterion/server';
import {checkout} from '../../../../lib/criterion/payments';
export async function POST(request:Request){try{
  const user=await identity();
  if(request.headers.get('origin')!==new URL(request.url).origin)throw new HttpError(403,'Запрос должен исходить из этого приложения.');
  const {documentId,receiptEmail}=z.object({documentId:z.string().uuid(),receiptEmail:z.string().trim().email().max(64).optional()}).strict().parse(await readBody(request));
  return json(await checkout(documentId,user.userId,receiptEmail||user.email));
}catch(e){return failure(e)}}
