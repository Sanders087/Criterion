import { z } from 'zod';
import { getDb } from '../../../db';
import { materials } from '../../../db/schema';
import { identity,json,failure,readBody } from '../../../lib/criterion/server';
import { templateSections } from '../../../lib/criterion/ai';
export async function PUT(req:Request){try{
 const user=await identity();const data=z.object({prompt:z.string().max(20000),template:z.string().max(60000),sources:z.string().max(120000)}).parse(await readBody(req));
 try{const sections=templateSections(data);if(new Set(sections.map(s=>s.id)).size!==sections.length)return json({error:'Идентификаторы разделов шаблона должны быть уникальными.'},400)}catch{return json({error:'Шаблон: JSON-массив из 3–30 разделов, каждый с уникальным id, title и непустым content.'},400)}
 const updatedAt=new Date().toISOString();await getDb().insert(materials).values({owner:user.userId,body:JSON.stringify(data),updatedAt}).onConflictDoUpdate({target:materials.owner,set:{body:JSON.stringify(data),updatedAt}});
 return json({...data,updatedAt});
}catch(e){return failure(e)}}
