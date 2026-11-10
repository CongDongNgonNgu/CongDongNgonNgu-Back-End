import type {Pool, PoolClient} from 'pg';
import {RUN_LIMITS,SLOT_ROLES} from './run-ledger-schema';
export {RUN_LIMITS} from './run-ledger-schema';
type Role=typeof SLOT_ROLES[number];
type Counter=keyof typeof RUN_LIMITS;
export interface RunSlot {key:string;operationKey:string;role:Role;id:string;attachmentId?:string;}
export interface PreparedRun {runId:string;activationId:string;manifestSha256:string;sourceSha:string;
 notBefore:string;expiresAt:string;limits:Record<Counter,number>;slots:RunSlot[];}
export interface ActiveRun {readonly runId:string;readonly activationId:string;readonly bootId:string;}
export interface Reservation {operationKey:string;slots:ReadonlyArray<{key:string;role:Role}>;charges:Partial<Record<Counter,number>>;}
const fail=():never=>{throw Error('TEST_ADMISSION_LEDGER');};
const uuid=(s:string)=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s);
const key=(s:string)=>typeof s==='string'&&/^[a-z0-9][a-z0-9._-]{0,79}$/.test(s);
const keys=Object.keys(RUN_LIMITS) as Counter[];
/** Inert repository: trusted pool injection only; never connects on import or
 * installs DDL. Own short transactions MUST finish before product/domain work.
 * Charges/burns are conservative, never refunded. No settlement or purge API. */
export class RunLedger {
 private readonly active=new WeakSet<ActiveRun>();
 constructor(private readonly pool:Pool){}
 private async transaction<T>(work:(client:PoolClient)=>Promise<T>):Promise<T>{
  let client:PoolClient|undefined;
  try{client=await this.pool.connect();await client.query('BEGIN');
   await client.query("SET LOCAL statement_timeout='3000ms'");await client.query("SET LOCAL lock_timeout='2000ms'");
   const value=await work(client);await client.query('COMMIT');return value;
  }catch{if(client)try{await client.query('ROLLBACK');}catch{/* No retry: commit outcome may be unknown. */}return fail();}
  finally{client?.release();}
 }
 async prepare(plan:PreparedRun):Promise<void>{
  if(!uuid(plan.runId)||!uuid(plan.activationId)||!/^[a-f0-9]{64}$/.test(plan.manifestSha256)||!/^[a-f0-9]{40}$/.test(plan.sourceSha)
   ||!Number.isFinite(Date.parse(plan.notBefore))||!Number.isFinite(Date.parse(plan.expiresAt))
   ||Date.parse(plan.expiresAt)<=Date.parse(plan.notBefore)||Date.parse(plan.expiresAt)-Date.parse(plan.notBefore)>600000
   ||!plan.limits||Object.keys(plan.limits).length!==keys.length||keys.some(k=>!Number.isSafeInteger(plan.limits[k])||plan.limits[k]<1||plan.limits[k]>RUN_LIMITS[k])
   ||!Array.isArray(plan.slots)||plan.slots.length<1||plan.slots.length>256)return fail();
  const slots=plan.slots.map(s=>({...s})),limits={...plan.limits};
  const facts={runId:plan.runId,activationId:plan.activationId,manifestSha256:plan.manifestSha256,sourceSha:plan.sourceSha,notBefore:plan.notBefore,expiresAt:plan.expiresAt};
  if(new Set(slots.map(s=>s.key)).size!==slots.length||new Set(slots.map(s=>s.id)).size!==slots.length
   ||slots.some(s=>!key(s.key)||!key(s.operationKey)||!SLOT_ROLES.includes(s.role)||!uuid(s.id)||(s.attachmentId!==undefined&&!uuid(s.attachmentId))))return fail();
  await this.transaction(async c=>{
   await c.query(`INSERT INTO phase30_test_execution.runs(run_id,activation_id,manifest_sha256,source_sha,service_id,not_before,expires_at,limits,slot_count)
    VALUES($1,$2,$3,$4,'srv-dahnerh594qs73fp3420',$5,$6,$7::jsonb,$8)`,[facts.runId,facts.activationId,facts.manifestSha256,facts.sourceSha,facts.notBefore,facts.expiresAt,JSON.stringify(limits),slots.length]);
   for(const s of slots.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0))await c.query(`INSERT INTO phase30_test_execution.slots(run_id,slot_key,operation_key,role,id,attachment_id) VALUES($1,$2,$3,$4,$5,$6)`,[facts.runId,s.key,s.operationKey,s.role,s.id,s.attachmentId??null]);
  });
 }
 async activate(runId:string,activationId:string,bootId:string):Promise<ActiveRun>{
  if(![runId,activationId,bootId].every(uuid))return fail();
  await this.transaction(async c=>{const result=await c.query(`UPDATE phase30_test_execution.runs SET state='ACTIVE',boot_id=$3
   WHERE run_id=$1 AND activation_id=$2 AND state='PREPARED' AND not_before<=clock_timestamp() AND expires_at>clock_timestamp() RETURNING run_id`,[runId,activationId,bootId]);if(result.rowCount!==1)fail();});
  const value=Object.freeze({runId,activationId,bootId});this.active.add(value);return value;
 }
 async reserve(active:ActiveRun,input:Reservation):Promise<ReadonlyArray<Readonly<RunSlot>>>{
  if(!this.active.has(active)||!key(input.operationKey)||!Array.isArray(input.slots)||input.slots.length>256
   ||new Set(input.slots.map(s=>s.key)).size!==input.slots.length||input.slots.some(s=>!key(s.key)||!SLOT_ROLES.includes(s.role))||!input.charges)return fail();
  const charges={...input.charges},operation=input.operationKey,slots=input.slots.map(s=>({...s})).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
  if(Object.keys(charges).some(k=>!keys.includes(k as Counter))||Object.values(charges).some(n=>!Number.isSafeInteger(n)||n!<0)
   ||(charges.authenticatedRequests??0)+(charges.anonymousRequests??0)!==1
   ||(charges.anonymousRequests===1&&((charges.ingressBytes??0)>0||(charges.authenticatedEgressBytes??0)>0||(charges.processingAttempts??0)>0))
   ||(charges.authenticatedRequests===1&&(charges.anonymousEgressBytes??0)>0))return fail();
  return this.transaction(async c=>{
   const r=(await c.query(`SELECT limits,counters FROM phase30_test_execution.runs WHERE run_id=$1 AND activation_id=$2 AND boot_id=$3
    AND state='ACTIVE' AND not_before<=clock_timestamp() AND expires_at>clock_timestamp() FOR UPDATE`,[active.runId,active.activationId,active.bootId])).rows[0];if(!r)fail();
   const counters:Record<string,number>={};for(const k of keys){counters[k]=Number(r.counters[k])+(charges[k]??0);if(!Number.isSafeInteger(counters[k])||counters[k]>Number(r.limits[k]))fail();}
   const result:RunSlot[]=[];
   for(const s of slots){const value=(await c.query(`UPDATE phase30_test_execution.slots SET state='BURNED' WHERE run_id=$1 AND slot_key=$2 AND role=$3 AND operation_key=$4 AND state='AVAILABLE'
    RETURNING id,attachment_id`,[active.runId,s.key,s.role,operation])).rows[0];if(!value)fail();result.push({key:s.key,role:s.role,operationKey:operation,id:value.id,...(value.attachment_id?{attachmentId:value.attachment_id}:{})});}
   await c.query('UPDATE phase30_test_execution.runs SET counters=$2::jsonb,recovery_debt=recovery_debt OR $3 WHERE run_id=$1',[active.runId,JSON.stringify(counters),slots.length>0]);
   return Object.freeze(result.map(s=>Object.freeze(s)));
  });
 }
}
