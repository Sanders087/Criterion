import {sameOrigin} from '../../../../lib/criterion/request-security';
import {z} from 'zod';
import {identity,json,apiDefaults, apiRoute,readBody,HttpError} from '../../../../lib/criterion/server';
import {paymentStatus} from '../../../../lib/criterion/payments';
export const POST = apiRoute('/api/payments/status', async (request:Request) => {
  const user=await identity();
  if(!sameOrigin(request))throw new HttpError(403,'Запрос должен исходить из этого приложения.');
  const {documentId}=z.object({documentId:z.string().uuid()}).strict().parse(await readBody(request));
  return json(await paymentStatus(documentId,user.userId));
});

export const { GET, HEAD, PUT, PATCH, DELETE, OPTIONS } = apiDefaults('/api/payments/status', ['POST']);
