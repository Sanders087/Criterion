import {packageAvailability,isOrderOperator,latestServiceOrder} from '../../../lib/criterion/service-orders';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '../../../db';
import { documents } from '../../../db/schema';
import { getAccount } from '../../../lib/criterion/auth';
import { json,failure,runtime,getMaterials } from '../../../lib/criterion/server';
import {checkoutReady} from '../../../lib/criterion/tbank';
export async function GET(){try{
 const user=await getAccount();const ai=Boolean(runtime().OPENAI_API_KEY);
 const paymentTestMode=Boolean(runtime().TBANK_TERMINAL_KEY?.trim().endsWith('DEMO'))||runtime().TBANK_API_URL==='https://rest-api-test.tinkoff.ru/v2/';
 if(!user)return json({user:null,ai,packages:packageAvailability(),documents:[],materials:{prompt:'',template:'',sources:''}});
 const docs=await getDb().select({id:documents.id,title:documents.title,kind:documents.kind,stage:documents.stage,billingState:documents.billingState,selectedPackage:documents.selectedPackage,updatedAt:documents.updatedAt,revision:documents.revision}).from(documents).where(eq(documents.owner,user.userId)).orderBy(desc(documents.updatedAt)).limit(200);
 return json({user:{name:user.displayName,email:user.email},ai,documents:await Promise.all(docs.map(async d=>({...d,order:await latestServiceOrder(d.id,user.userId)}))),materials:await getMaterials(user.userId),packages:packageAvailability(),orderOperator:isOrderOperator(user.userId),paymentsReady:checkoutReady(runtime()),paymentTestMode});
}catch(e){return failure(e)}}
