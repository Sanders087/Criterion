import { z } from 'zod';
import { getDb } from '../../../db';
import { materials } from '../../../db/schema';
import { identity,json,apiDefaults, apiRoute,HttpError,readBody } from '../../../lib/criterion/server';
import { templateSections } from '../../../lib/criterion/ai';
export const PUT = apiRoute('/api/materials', async (req:Request) => {
 const user=await identity();const data=z.object({prompt:z.string().max(20000),template:z.string().max(60000),sources:z.string().max(120000)}).parse(await readBody(req));
 try{const sections=templateSections(data);if(new Set(sections.map(s=>s.id)).size!==sections.length)throw new HttpError(400,'Идентификаторы разделов шаблона должны быть уникальными.')}catch(cause){if(cause instanceof HttpError)throw cause;throw new HttpError(400,'Шаблон: JSON-массив из 3–30 разделов, каждый с уникальным id, title и непустым content.',cause)}
 const updatedAt=new Date().toISOString();await getDb().insert(materials).values({owner:user.userId,body:JSON.stringify(data),updatedAt}).onConflictDoUpdate({target:materials.owner,set:{body:JSON.stringify(data),updatedAt}});
 return json({...data,updatedAt});
});

export const { GET, HEAD, POST, PATCH, DELETE, OPTIONS } = apiDefaults('/api/materials', ['PUT']);
