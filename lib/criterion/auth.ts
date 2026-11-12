import {env} from 'cloudflare:workers';
import {headers} from 'next/headers';
export const COOKIE='__Host-criterion_session';
const encoder=new TextEncoder();
export const randomToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
export async function digest(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))),b=>b.toString(16).padStart(2,'0')).join('')}
export async function passwordHash(password:string,salt:string){const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);return Array.from(new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:encoder.encode(salt),iterations:100000},key,256)),b=>b.toString(16).padStart(2,'0')).join('')}
export function equal(a:string,b:string){let diff=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)diff|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return diff===0}
export function sessionToken(h:Headers){return h.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1)||''}
export async function getAccount(){const h=await headers();const token=sessionToken(h);if(!/^[a-f0-9]{64}$/.test(token))return null;const row=await env.DB!.prepare('SELECT a.id,a.email,a.email_verified_at FROM accounts a JOIN sessions s ON s.account_id=a.id WHERE s.token_hash=? AND s.expires_at>?').bind(await digest(token),Date.now()).first<{id:string,email:string,email_verified_at:number|null}>();return row?{userId:row.id,email:row.email,displayName:row.email,fullName:null,emailVerified:!!row.email_verified_at}:null}
export const sessionCookie=(token:string,age=60*60*24*14)=>`${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
