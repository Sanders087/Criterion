import {PACKAGE_IDS} from '../../../../lib/criterion/packages';
import {sameOrigin} from '../../../../lib/criterion/request-security';
import {z} from 'zod';
import {identity,json,failure,readBody,HttpError} from '../../../../lib/criterion/server';
import {checkout} from '../../../../lib/criterion/payments';
export async function POST(request:Request){try{
  const user=await identity();
  if(!sameOrigin(request))throw new HttpError(403,'Запрос должен исходить из этого приложения.');
  const {documentId,receiptEmail,packageId}=z.object({documentId:z.string().uuid(),packageId:z.enum(PACKAGE_IDS),receiptEmail:z.string().trim().email().max(64).optional()}).strict().parse(await readBody(request));
  return json(await checkout(documentId,user.userId,receiptEmail||user.email,packageId));
}catch(e){return failure(e)}}
