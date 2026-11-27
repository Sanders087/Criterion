import {env} from '../runtime';
import type {Contract} from './domain';
import {packageById,packageContents,type PackageAvailability,type PackageId,type OrderSnapshot,type ServiceOrder} from './packages';
import {HttpError} from './server';

export function isOrderOperator(accountId:string){return (env.CRITERION_ORDER_OPERATORS||'').split(',').map(s=>s.trim()).filter(Boolean).includes(accountId);}
export function packageAvailability():PackageAvailability {
 const signature=env.CRITERION_SIGNATURE_TERMS?.trim(),video=env.CRITERION_VIDEO_TERMS?.trim(),consultation=env.CRITERION_CONSULTATION_TERMS?.trim();
 const enabled=env.CRITERION_SERVICES_ENABLED==='true'&&Boolean(env.CRITERION_ORDER_OPERATORS?.trim());
 const base='Договор доступен в личном кабинете после подтверждения оплаты банком.';
 return {contract:{available:true,terms:[base]},video:{available:Boolean(enabled&&signature&&video),terms:[base,...(signature?[signature]:[]),...(video?[video]:[])]},consultation:{available:Boolean(enabled&&signature&&consultation),terms:[base,...(signature?[signature]:[]),...(consultation?[consultation]:[])]}};
}
export function snapshotPackage(id:PackageId):OrderSnapshot {
 const p=packageById(id)!;const availability=packageAvailability()[id];
 if(!availability.available)throw new HttpError(409,'Этот пакет пока не доступен для покупки. Выберите «Договор».');
 return {id:p.id,name:p.name,amount:p.amount,signature:p.signature,video:p.video,consultationMinutes:p.consultationMinutes,contents:packageContents(p),terms:availability.terms};
}
export type OrderRow={id:string;document_id:string;owner:string;status:string;amount:number;package_snapshot:string;signature_file:Uint8Array|null;video_url:string|null;consultation_at:string|null;consultation_timezone:string|null;meeting_url:string|null;consultation_status:string;fulfillment_revision:number};
export function presentOrder(row:OrderRow):ServiceOrder {
 const snapshot=JSON.parse(row.package_snapshot) as OrderSnapshot;
 const paid=['CONFIRMED','PARTIAL_REFUNDED'].includes(row.status);
 return {id:row.id,documentId:row.document_id,paymentStatus:row.status,paid,snapshot:{...snapshot,amount:row.amount},signatureReady:paid&&Boolean(row.signature_file),videoUrl:paid?row.video_url:null,consultationAt:paid?row.consultation_at:null,timezone:paid?row.consultation_timezone:null,meetingUrl:paid&&['scheduled','completed'].includes(row.consultation_status)?row.meeting_url:null,consultationStatus:paid?row.consultation_status:'unpaid',complete:paid&&(!snapshot.signature||Boolean(row.signature_file))&&(!snapshot.video||Boolean(row.video_url))&&(!snapshot.consultationMinutes||row.consultation_status==='completed'),version:row.fulfillment_revision};
}
export async function attachOrder(doc:Contract,owner:string):Promise<Contract>{
 const order=await latestServiceOrder(doc.id,owner);
 if(!order)return doc;return {...doc,order,billing:doc.billing?{...doc.billing,price:order.snapshot.amount}:undefined};
}
export async function latestServiceOrder(documentId:string,owner:string){
 const row=await env.DB.prepare('SELECT id,document_id,owner,status,amount,package_snapshot,(signature_file IS NOT NULL) AS signature_file,video_url,consultation_at,consultation_timezone,meeting_url,consultation_status,fulfillment_revision FROM payment_orders WHERE document_id=? AND owner=? ORDER BY created_at DESC,rowid DESC LIMIT 1').bind(documentId,owner).first<OrderRow>();
 return row?presentOrder(row):undefined;
}
export async function getServiceOrder(id:string,userId:string,operator=false){
 const row=await env.DB.prepare('SELECT * FROM payment_orders WHERE id=?').bind(id).first<OrderRow>();
 if(!row||(row.owner!==userId&&(!operator||!JSON.parse(row.package_snapshot).signature)))throw new HttpError(404,'Заказ не найден.');
 return row;
}
