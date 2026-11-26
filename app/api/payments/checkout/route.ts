import {sameOrigin} from '../../../../lib/criterion/request-security';
import {z} from 'zod';
import {identity,json,apiDefaults, apiRoute,readBody,HttpError} from '../../../../lib/criterion/server';
import {checkout} from '../../../../lib/criterion/payments';
export const POST = apiRoute('/api/payments/checkout', async (request:Request) => {
  const user=await identity();
  if(!sameOrigin(request))throw new HttpError(403,'Запрос должен исходить из этого приложения.');
  const {documentId,receiptEmail}=z.object({documentId:z.string().uuid(),receiptEmail:z.string().trim().email().max(64).optional()}).strict().parse(await readBody(request));
  return json(await checkout(documentId,user.userId,receiptEmail||user.email));
});

export const { GET, HEAD, PUT, PATCH, DELETE, OPTIONS } = apiDefaults('/api/payments/checkout', ['POST']);
