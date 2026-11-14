import {z} from 'zod';
import {identity,json,failure,readBody,HttpError} from '../../../../lib/criterion/server';
import {paymentStatus} from '../../../../lib/criterion/payments';
export async function POST(request:Request){try{
  const user=await identity();
  if(request.headers.get('origin')!==new URL(request.url).origin)throw new HttpError(403,'Запрос должен исходить из этого приложения.');
  const {documentId}=z.object({documentId:z.string().uuid()}).strict().parse(await readBody(request));
  return json(await paymentStatus(documentId,user.userId));
}catch(e){return failure(e)}}
