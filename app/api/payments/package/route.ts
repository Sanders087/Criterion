import {z} from 'zod';
import {identity,json,failure,readBody,HttpError} from '../../../../lib/criterion/server';
import {sameOrigin} from '../../../../lib/criterion/request-security';
import {PACKAGE_IDS} from '../../../../lib/criterion/packages';
import {selectPackage} from '../../../../lib/criterion/payments';
export async function POST(request:Request){try{
 const user=await identity();if(!sameOrigin(request))throw new HttpError(403,'Запрос должен исходить из этого приложения.');
 const data=z.object({documentId:z.string().uuid(),packageId:z.enum(PACKAGE_IDS),acknowledge:z.literal(true)}).strict().parse(await readBody(request));
 return json(await selectPackage(data.documentId,user.userId,data.packageId));
}catch(e){return failure(e)}}
