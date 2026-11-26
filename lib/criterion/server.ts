import {sameOrigin} from './request-security';
import { env } from '../runtime';
import { getAccount } from './auth';
import { getDb } from '../../db';
import { materials } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { EMPTY_MATERIALS, type Contract, type Materials } from './domain';
import { CRITERION_TEMPLATE } from './templates';
import { LAWYER_PROMPT } from './legal-defaults';
import type { AIEnv } from './ai';
import type { TBankEnv } from './tbank';
import { HttpError } from './app-error.ts';
export { HttpError } from './app-error.ts';
export { apiDefaults, apiRoute } from './api-observability.ts';

export const runtime=()=>env as AIEnv & TBankEnv;
export async function identity(){const user=await getAccount();if(!user)throw new HttpError(401,'Войдите, чтобы сохранять документы и продолжать работу с любого устройства.');return user}
export function json(data:unknown,status=200){return Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}})}
export async function readBody(request:Request){
 const origin=request.headers.get('Origin');
 if(origin && !sameOrigin(request))throw new HttpError(403,'Запрос должен исходить из этого приложения.');
 if(request.headers.get('sec-fetch-site')==='cross-site')throw new HttpError(403,'Запрос отклонён.');
 if(!request.headers.get('content-type')?.includes('application/json'))throw new HttpError(415,'Ожидается JSON.');
 if(Number(request.headers.get('content-length')||0)>350000)throw new HttpError(413,'Слишком большой запрос.');
 const text=await request.text();if(text.length>350000)throw new HttpError(413,'Слишком большой запрос.');
 return parseBodyJson(text);
}
export async function getMaterials(owner:string):Promise<Materials>{const [row]=await getDb().select().from(materials).where(eq(materials.owner,owner));const saved=row?JSON.parse(row.body):{...EMPTY_MATERIALS,template:JSON.stringify(CRITERION_TEMPLATE,null,2)};return {...saved,prompt:saved.prompt?.trim()||LAWYER_PROMPT,...(row?{updatedAt:row.updatedAt}:{})}}
export function unpack(row:{body:string;revision:number}):Contract{return {...JSON.parse(row.body),revision:row.revision}}

export function parseBodyJson(text: string): unknown {
  try { return JSON.parse(text); }
  catch (cause) { throw new HttpError(400, 'Не удалось прочитать данные запроса.', cause); }
}
