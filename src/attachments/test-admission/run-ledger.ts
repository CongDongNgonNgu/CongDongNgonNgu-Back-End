import type {Pool, PoolClient} from 'pg';
import {RUN_LIMITS,SLOT_ROLES} from './run-ledger-schema';
export {RUN_LIMITS} from './run-ledger-schema';
type Role=typeof SLOT_ROLES[number];
type Counter=keyof typeof RUN_LIMITS;
export interface RunSlot {key:string;operationKey:string;role:Role;id:string;attachmentId?:string;}
export interface PreparedRun {runId:string;activationId:string;manifestSha256:string;sourceSha:string;
 notBefore:string;expiresAt:string;limits:Record<Counter,number>;slots:RunSlot[];requests?:RequestPreparation;}
export interface RequestCandidate {key:string;method:'GET'|'HEAD'|'POST'|'PUT'|'PATCH'|'DELETE';path:string;authClass:'AUTH'|'ANON';ingressBytes:number;egressBytes:number;}
export interface RequestAttempt {key:string;candidateKey:string;}
export interface RequestPreparation {candidates:RequestCandidate[];attempts:RequestAttempt[];}
/** Process-local reservation only; not operation/identity/provider authority. */
export interface RequestReservation {readonly runId:string;readonly candidateKey:string;readonly attemptKey:string;}
export interface ActiveRun {readonly runId:string;readonly activationId:string;readonly bootId:string;}
export interface Reservation {operationKey:string;slots:ReadonlyArray<{key:string;role:Role}>;charges:Partial<Record<Counter,number>>;}
const fail=():never=>{throw Error('TEST_ADMISSION_LEDGER');};
const uuid=(s:string)=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s);
const key=(s:string)=>typeof s==='string'&&/^[a-z0-9][a-z0-9._-]{0,79}$/.test(s);
const keys=Object.keys(RUN_LIMITS) as Counter[];

function closed(value:unknown,names:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return fail();
 const fields=Reflect.ownKeys(value);if(fields.length!==names.length||fields.some(k=>typeof k!=='string'||!names.includes(k)))return fail();
 const out=Object.create(null) as Record<string,unknown>;for(const name of names){const d=Object.getOwnPropertyDescriptor(value,name);if(!d||!d.enumerable||!('value'in d))return fail();out[name]=d.value;}return out;
}
function bounded(value:unknown):unknown[]{
 if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)return fail();const n=Object.getOwnPropertyDescriptor(value,'length')?.value as unknown;
 if(typeof n!=='number'||!Number.isSafeInteger(n)||n<1||n>140||Reflect.ownKeys(value).length!==n+1)return fail();
 const out:unknown[]=[];for(let i=0;i<n;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!d.enumerable||!('value'in d))return fail();out.push(d.value);}return out;
}
function requestPreparation(value:unknown,limits:Record<Counter,number>):RequestPreparation{
 try{
  const root=closed(value,['candidates','attempts']),seen=new Set<string>(),observable=new Set<string>();
  const candidates=bounded(root.candidates).map(raw=>{const c=closed(raw,['key','method','path','authClass','ingressBytes','egressBytes']);
   if(typeof c.key!=='string'||!key(c.key)||seen.has(c.key)||!['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(c.method as string)||typeof c.path!=='string'||c.path.length>160||!/^\/api\/v1\/attachments(?:\/[a-f0-9-]{36}(?:\/(?:content|preview|finalize|metadata))?)?$/.test(c.path)||(c.authClass!=='AUTH'&&c.authClass!=='ANON')||typeof c.ingressBytes!=='number'||!Number.isSafeInteger(c.ingressBytes)||c.ingressBytes<0||c.ingressBytes>limits.ingressBytes||typeof c.egressBytes!=='number'||!Number.isSafeInteger(c.egressBytes)||c.egressBytes<0||c.egressBytes>limits[c.authClass==='AUTH'?'authenticatedEgressBytes':'anonymousEgressBytes']||(c.authClass==='ANON'&&(c.ingressBytes!==0||!['GET','HEAD'].includes(c.method as string)||!/(?:content|preview)$/.test(c.path))))return fail();
   const signature=JSON.stringify([c.method,c.path,c.authClass]);if(observable.has(signature))return fail();observable.add(signature);seen.add(c.key);return {...c} as unknown as RequestCandidate;
  });
  const attemptKeys=new Set<string>(),used=new Set<string>(),total=Object.fromEntries(keys.map(k=>[k,0])) as Record<Counter,number>;
  const attempts=bounded(root.attempts).map(raw=>{const a=closed(raw,['key','candidateKey']);if(typeof a.key!=='string'||!key(a.key)||attemptKeys.has(a.key)||typeof a.candidateKey!=='string')return fail();const c=candidates.find(c=>c.key===a.candidateKey);if(!c)return fail();attemptKeys.add(a.key);used.add(c.key);total[c.authClass==='AUTH'?'authenticatedRequests':'anonymousRequests']++;total.ingressBytes+=c.ingressBytes;total[c.authClass==='AUTH'?'authenticatedEgressBytes':'anonymousEgressBytes']+=c.egressBytes;return {key:a.key,candidateKey:c.key};});
  if(used.size!==candidates.length||keys.some(k=>!Number.isSafeInteger(total[k])||total[k]>limits[k]))return fail();
  return {candidates:candidates.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0),attempts:attempts.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0)};
 }catch{return fail();}
}

/** Inert repository: trusted pool injection only; never connects on import or
 * installs DDL. Own short transactions MUST finish before product/domain work.
 * Charges/burns are conservative, never refunded. No settlement or purge API. */
export class RunLedger {
 private readonly active=new WeakSet<ActiveRun>();
 private readonly requests=new WeakMap<RequestReservation,{active:ActiveRun;attemptKey:string}>();
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
  const requestField=Object.getOwnPropertyDescriptor(plan,'requests');
  if(requestField&&(!requestField.enumerable||!('value'in requestField)))return fail();
  const requests=requestField?.value===undefined?undefined:requestPreparation(requestField.value,limits);
  await this.transaction(async c=>{
   await c.query(`INSERT INTO phase30_test_execution.runs(run_id,activation_id,manifest_sha256,source_sha,service_id,not_before,expires_at,limits,slot_count,candidate_count,request_count)
    VALUES($1,$2,$3,$4,'srv-dahnerh594qs73fp3420',$5,$6,$7::jsonb,$8,$9,$10)`,[facts.runId,facts.activationId,facts.manifestSha256,facts.sourceSha,facts.notBefore,facts.expiresAt,JSON.stringify(limits),slots.length,requests?.candidates.length??0,requests?.attempts.length??0]);
   for(const s of slots.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0))await c.query(`INSERT INTO phase30_test_execution.slots(run_id,slot_key,operation_key,role,id,attachment_id) VALUES($1,$2,$3,$4,$5,$6)`,[facts.runId,s.key,s.operationKey,s.role,s.id,s.attachmentId??null]);
   for(const cnd of requests?.candidates??[])await c.query('INSERT INTO phase30_test_execution.request_candidates(run_id,candidate_key,method,path,auth_class,ingress_bytes,egress_bytes) VALUES($1,$2,$3,$4,$5,$6,$7)',[facts.runId,cnd.key,cnd.method,cnd.path,cnd.authClass,cnd.ingressBytes,cnd.egressBytes]);
   for(const a of requests?.attempts??[])await c.query('INSERT INTO phase30_test_execution.request_attempts(run_id,attempt_key,candidate_key) VALUES($1,$2,$3)',[facts.runId,a.key,a.candidateKey]);
   await c.query('UPDATE phase30_test_execution.runs SET preparation_sealed=true WHERE run_id=$1',[facts.runId]);

  });
 }
 async activate(runId:string,activationId:string,bootId:string):Promise<ActiveRun>{
  if(![runId,activationId,bootId].every(uuid))return fail();
  await this.transaction(async c=>{const result=await c.query(`UPDATE phase30_test_execution.runs SET state='ACTIVE',boot_id=$3
   WHERE run_id=$1 AND activation_id=$2 AND state='PREPARED' AND not_before<=clock_timestamp() AND expires_at>clock_timestamp() RETURNING run_id`,[runId,activationId,bootId]);if(result.rowCount!==1)fail();});
  const value=Object.freeze({runId,activationId,bootId});this.active.add(value);return value;
 }

 /** Pre-parser accounting only. Stored immutable ceilings are charged by the
  * database transition, never supplied by the caller. No refunds or role burns.
  * Candidate compilation/bindOperation/middleware remain unimplemented. */
 async reserveRequest(active:ActiveRun,candidateKey:string):Promise<RequestReservation>{
  if(!this.active.has(active)||!key(candidateKey))return fail();
  const attempt=await this.transaction(async c=>{
   const run=(await c.query("SELECT run_id FROM phase30_test_execution.runs WHERE run_id=$1 AND activation_id=$2 AND boot_id=$3 AND state='ACTIVE' AND preparation_sealed AND request_count>0 AND not_before<=clock_timestamp() AND expires_at>clock_timestamp() FOR UPDATE",[active.runId,active.activationId,active.bootId])).rows[0];if(!run)return fail();
   const row=(await c.query("SELECT attempt_key,candidate_key FROM phase30_test_execution.request_attempts WHERE run_id=$1 AND candidate_key=$2 AND state='AVAILABLE' ORDER BY attempt_key COLLATE \"C\" LIMIT 1 FOR UPDATE",[active.runId,candidateKey])).rows[0];if(!row||typeof row.attempt_key!=='string'||!key(row.attempt_key)||row.candidate_key!==candidateKey)return fail();
   const changed=await c.query("UPDATE phase30_test_execution.request_attempts SET state='RESERVED',boot_id=$3 WHERE run_id=$1 AND attempt_key=$2 AND state='AVAILABLE' RETURNING attempt_key",[active.runId,row.attempt_key,active.bootId]);if(changed.rowCount!==1)return fail();
   return {attemptKey:String(row.attempt_key),candidateKey:String(row.candidate_key)};
  });
  const handle=Object.freeze({runId:active.runId,...attempt});this.requests.set(handle,{active,attemptKey:attempt.attemptKey});return handle;
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
