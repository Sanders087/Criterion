import { z } from 'zod';
import { getDb } from '../../../db';
import { documents } from '../../../db/schema';
import { makeContract } from '../../../lib/criterion/domain';
import { identity,json,failure,readBody,runtime } from '../../../lib/criterion/server';
export async function POST(req:Request){try{
 const user=await identity();const data=z.object({kind:z.enum(['services','sale','lease','work','nda','other']),mode:z.enum(['form','ai']),title:z.string().max(160).optional()}).parse(await readBody(req));
 if(data.mode==='ai'&&!runtime().OPENAI_API_KEY)return json({error:'ИИ пока не подключён. Выберите анкету.'},503);
 const doc=makeContract(data.kind,data.mode,data.title);await getDb().insert(documents).values({id:doc.id,owner:user.userId,title:doc.title,kind:doc.kind,stage:doc.stage,body:JSON.stringify(doc),revision:0,createdAt:doc.createdAt,updatedAt:doc.updatedAt});
 return json(doc,201);
}catch(e){return failure(e)}}
