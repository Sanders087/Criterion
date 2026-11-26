import { z } from 'zod';
import { getDb } from '../../../db';
import { documents } from '../../../db/schema';
import { makeContract } from '../../../lib/criterion/domain';
import { presentContract } from '../../../lib/criterion/billing';
import { identity,json,apiDefaults, apiRoute,HttpError,readBody,runtime } from '../../../lib/criterion/server';
export const POST = apiRoute('/api/documents', async (req:Request) => {
 const user=await identity();const data=z.object({kind:z.enum(['services','sale','lease','work','nda','other']),mode:z.enum(['form','ai']),title:z.string().max(160).optional()}).parse(await readBody(req));
 if(data.mode==='ai'&&!runtime().OPENAI_API_KEY)throw new HttpError(503,'ИИ пока не подключён. Выберите анкету.');
 const doc=makeContract(data.kind,data.mode,data.title);const row={id:doc.id,owner:user.userId,title:doc.title,kind:doc.kind,stage:doc.stage,body:JSON.stringify(doc),revision:0,createdAt:doc.createdAt,updatedAt:doc.updatedAt,billingState:'unpaid',aiOperationsUsed:0};await getDb().insert(documents).values(row);
 return json(presentContract(row),201);
});

export const { GET, HEAD, PUT, PATCH, DELETE, OPTIONS } = apiDefaults('/api/documents', ['POST']);
