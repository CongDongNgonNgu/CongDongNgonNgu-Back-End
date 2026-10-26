import type {PoolClient} from 'pg';
import {ATTACHMENT_LIMITS as L} from './attachment-policy';
type Failure='ATTACHMENT_RATE_LIMITED'|'ATTACHMENT_QUOTA_EXCEEDED'|'ATTACHMENT_BUSY'|'ATTACHMENT_QUOTA_INTEGRITY'|'ATTACHMENT_QUOTA_LOCK_ORDER';
export class AttachmentQuotaError extends Error {constructor(readonly code:Failure){super(code);this.name='AttachmentQuotaError';}}
type Kind='ACTOR'|'IP'|'DEPLOYMENT';
interface Change {kind:Kind;subject:string;action:'bytes'|'metadata'|'upload'|'pending'|'initiate'|'source'|'read'|'upload_attempt'|'ingress';window:Date;delta:number;ceiling:number;}
export interface AttachmentCapacityChange {bytesDelta?:number;metadataDelta?:0|1|-1;uploadDelta?:0|1|-1;pendingDelta?:0|1|-1;}
interface HeldCounterLocks {xid:string;keys:Set<string>;maximum:Change|null;failed:boolean;}
const heldLocks=new WeakMap<PoolClient,HeldCounterLocks>();
interface CounterQueue {tail:Promise<void>;failed:boolean;failure?:unknown;}
const counterQueues=new WeakMap<PoolClient,CounterQueue>();
const DEPLOYMENT='congdongngonngu-test';const EPOCH=new Date(0);
const fail=(code:Failure):never=>{throw new AttachmentQuotaError(code);};
function actorId(value:string):void{if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))fail('ATTACHMENT_QUOTA_INTEGRITY');}
const rank:Record<Kind,number>={ACTOR:0,IP:1,DEPLOYMENT:2};const cmp=(a:string,b:string)=>a<b?-1:a>b?1:0;
/** Caller owns transaction. Rate admission uses a separate rate-only transaction;
 * reservation changes run after domain/attachment locks. This port never releases
 * physical debt without the caller's verified DB/object lifecycle evidence.
 */
export class AttachmentQuotaLedger {
 constructor(private readonly clock:(client:PoolClient)=>Promise<Date>=async client=>(await client.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now){}
 private async windows(client:PoolClient){const now=await this.clock(client);if(!(now instanceof Date)||!Number.isFinite(now.getTime()))return fail('ATTACHMENT_QUOTA_INTEGRITY');const floor=(ms:number)=>new Date(Math.floor(now.getTime()/ms)*ms);return {minute:floor(60000),hour:floor(3600000),day:floor(86400000)};}
 private async apply(client:PoolClient,changes:Change[],code:Failure):Promise<void>{
  // One queue per physical client, shared across ledger instances. A failed batch
  // skips queued SQL so Promise.all rollback cannot race with late mutations.
  let queue=counterQueues.get(client);
  if(!queue){queue={tail:Promise.resolve(),failed:false};counterQueues.set(client,queue);}
  const batch=queue;
  const operation=batch.tail.then(async()=>{
   if(batch.failed)throw batch.failure;
   await this.applyOrdered(client,changes,code);
  }).catch(error=>{
   batch.failed=true;batch.failure=error;
   const held=heldLocks.get(client);if(held)held.failed=true;
   throw error;
  });
  const tail=operation.then(()=>undefined,()=>undefined);batch.tail=tail;
  try{await operation;}finally{if(batch.tail===tail)counterQueues.delete(client);}
 }
 private async applyOrdered(client:PoolClient,changes:Change[],code:Failure):Promise<void>{
  const order=(a:Change,b:Change)=>rank[a.kind]-rank[b.kind]||cmp(a.subject,b.subject)||cmp(a.action,b.action)||cmp(a.window.toISOString(),b.window.toISOString());
  const key=(c:Change)=>[c.kind,c.subject,c.action,c.window.toISOString()].join('|');
  const sorted=[...changes].sort(order);
  const xid=(await client.query<{id:string}>('SELECT pg_current_xact_id()::text AS id')).rows[0].id;
  let held=heldLocks.get(client);if(!held||held.xid!==xid){held={xid,keys:new Set(),maximum:null,failed:false};heldLocks.set(client,held);}
  if(held.failed)return fail('ATTACHMENT_QUOTA_INTEGRITY');
  if(held.maximum&&sorted.some(c=>!held!.keys.has(key(c))&&order(c,held!.maximum!)<0))return fail('ATTACHMENT_QUOTA_LOCK_ORDER');
  for(const c of sorted){
   if(!Number.isSafeInteger(c.delta)||!Number.isSafeInteger(c.ceiling)||c.ceiling<1||Math.abs(c.delta)>L.deploymentReservedBytes)return fail('ATTACHMENT_QUOTA_INTEGRITY');
   await client.query(`INSERT INTO attachment_quota_counters(kind,subject,action,window_start,used,ceiling) VALUES($1,$2,$3,$4,0,$5) ON CONFLICT DO NOTHING`,[c.kind,c.subject,c.action,c.window,c.ceiling]);
   const result=await client.query(`UPDATE attachment_quota_counters SET used=used+$5,updated_at=clock_timestamp() WHERE kind=$1 AND subject=$2 AND action=$3 AND window_start=$4 AND ceiling=$6 AND used+$5 BETWEEN 0 AND ceiling RETURNING used`,[c.kind,c.subject,c.action,c.window,c.delta,c.ceiling]);
   if(result.rowCount!==1)return fail(code);
   held.keys.add(key(c));if(!held.maximum||order(c,held.maximum)>0)held.maximum=c;
  }
 }
 /** Batch the union of counters for a lifecycle transition. Every failure requires whole-transaction rollback. */
 async changeCapacity(client:PoolClient,actor:string,change:AttachmentCapacityChange):Promise<void>{
  actorId(actor);const {bytesDelta=0,metadataDelta=0,uploadDelta=0,pendingDelta=0}=change;
  if(!Number.isSafeInteger(bytesDelta)||![0,1,-1].includes(metadataDelta)||![0,1,-1].includes(uploadDelta)||![0,1,-1].includes(pendingDelta))return fail('ATTACHMENT_QUOTA_INTEGRITY');
  const changes:Change[]=[];
  if(bytesDelta)changes.push({kind:'ACTOR',subject:actor,action:'bytes',window:EPOCH,delta:bytesDelta,ceiling:L.actorReservedBytes},{kind:'DEPLOYMENT',subject:DEPLOYMENT,action:'bytes',window:EPOCH,delta:bytesDelta,ceiling:L.deploymentReservedBytes});
  if(metadataDelta)changes.push({kind:'DEPLOYMENT',subject:DEPLOYMENT,action:'metadata',window:EPOCH,delta:metadataDelta,ceiling:L.deploymentMetadata});
  if(uploadDelta)changes.push({kind:'ACTOR',subject:actor,action:'upload',window:EPOCH,delta:uploadDelta,ceiling:L.actorActiveUploads},{kind:'DEPLOYMENT',subject:DEPLOYMENT,action:'upload',window:EPOCH,delta:uploadDelta,ceiling:L.deploymentActiveUploads});
  if(pendingDelta)changes.push({kind:'DEPLOYMENT',subject:DEPLOYMENT,action:'pending',window:EPOCH,delta:pendingDelta,ceiling:L.pendingJobs});
  if(changes.length)await this.apply(client,changes,uploadDelta>0||pendingDelta>0?'ATTACHMENT_BUSY':'ATTACHMENT_QUOTA_EXCEEDED');
 }
 async changeReservation(client:PoolClient,actor:string,bytesDelta:number,metadataDelta:0|1|-1):Promise<void>{await this.changeCapacity(client,actor,{bytesDelta,metadataDelta});}
 async changeSlots(client:PoolClient,actor:string,slot:'upload'|'pending',delta:1|-1):Promise<void>{
  if(!['upload','pending'].includes(slot)||![1,-1].includes(delta))return fail('ATTACHMENT_QUOTA_INTEGRITY');
  await this.changeCapacity(client,actor,slot==='upload'?{uploadDelta:delta}:{pendingDelta:delta});
 }
 async consumeInitiation(client:PoolClient,actor:string,sourceBytes:number):Promise<void>{
  actorId(actor);if(!Number.isSafeInteger(sourceBytes)||sourceBytes<1||sourceBytes>L.imageBytes)return fail('ATTACHMENT_QUOTA_INTEGRITY');
  const w=await this.windows(client);
  await this.apply(client,[{kind:'ACTOR',subject:actor,action:'initiate',window:w.hour,delta:1,ceiling:L.actorInitiationsPerHour},{kind:'ACTOR',subject:actor,action:'source',window:w.day,delta:sourceBytes,ceiling:L.actorSourceBytesPerDay},{kind:'DEPLOYMENT',subject:DEPLOYMENT,action:'initiate',window:w.hour,delta:1,ceiling:L.deploymentInitiationsPerHour},{kind:'DEPLOYMENT',subject:DEPLOYMENT,action:'source',window:w.day,delta:sourceBytes,ceiling:L.deploymentSourceBytesPerDay}],'ATTACHMENT_RATE_LIMITED');
 }
 /** Rate-only admission before each raw body, including completed replays and
  * failed intakes. Conservatively charge its exact expected maximum bytes once;
  * this is separate from initiation idempotency and retained-byte reservations.
  * Uses the already frozen attempt/hour and source/day ceilings, no new budget. */
 async consumeUploadAttempt(client:PoolClient,actor:string,expectedBytes:number):Promise<void>{
  actorId(actor);if(!Number.isSafeInteger(expectedBytes)||expectedBytes<1||expectedBytes>L.imageBytes)return fail('ATTACHMENT_QUOTA_INTEGRITY');
  const w=await this.windows(client);
  await this.apply(client,[{kind:'ACTOR',subject:actor,action:'upload_attempt',window:w.hour,delta:1,ceiling:L.actorInitiationsPerHour},{kind:'ACTOR',subject:actor,action:'ingress',window:w.day,delta:expectedBytes,ceiling:L.actorSourceBytesPerDay},{kind:'DEPLOYMENT',subject:DEPLOYMENT,action:'upload_attempt',window:w.hour,delta:1,ceiling:L.deploymentInitiationsPerHour},{kind:'DEPLOYMENT',subject:DEPLOYMENT,action:'ingress',window:w.day,delta:expectedBytes,ceiling:L.deploymentSourceBytesPerDay}],'ATTACHMENT_RATE_LIMITED');
 }
 async consumeRead(client:PoolClient,actor:string|null,trustedIpHash?:string):Promise<void>{
  if(actor!==null)actorId(actor);else if(!/^[a-f0-9]{64}$/.test(trustedIpHash??''))return fail('ATTACHMENT_QUOTA_INTEGRITY');
  const w=await this.windows(client);
  await this.apply(client,[{kind:actor?'ACTOR':'IP',subject:actor??trustedIpHash!,action:'read',window:w.minute,delta:1,ceiling:actor?L.actorReadsPerMinute:L.anonymousReadsPerMinute},{kind:'DEPLOYMENT',subject:DEPLOYMENT,action:'read',window:w.minute,delta:1,ceiling:L.deploymentReadsPerMinute}],'ATTACHMENT_RATE_LIMITED');
 }
}
