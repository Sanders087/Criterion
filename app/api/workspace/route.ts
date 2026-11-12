import { desc, eq } from 'drizzle-orm';
import { getDb } from '../../../db';
import { documents } from '../../../db/schema';
import { getAccount } from '../../../lib/criterion/auth';
import { json,failure,runtime,getMaterials } from '../../../lib/criterion/server';
export async function GET(){try{
 const user=await getAccount();const ai=Boolean(runtime().OPENAI_API_KEY);
 if(!user)return json({user:null,ai,documents:[],materials:{prompt:'',template:'',sources:''}});
 const docs=await getDb().select({id:documents.id,title:documents.title,kind:documents.kind,stage:documents.stage,updatedAt:documents.updatedAt,revision:documents.revision}).from(documents).where(eq(documents.owner,user.userId)).orderBy(desc(documents.updatedAt)).limit(200);
 return json({user:{name:user.displayName,email:user.email},ai,documents:docs,materials:await getMaterials(user.userId)});
}catch(e){return failure(e)}}
