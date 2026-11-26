import {randomUUID,createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {SqlHarness} from '../phase22/sql-harness';
import {RunLedger, RUN_LIMITS, type PreparedRun} from '../../src/attachments/test-admission/run-ledger';
import {ActivationControlRepository,type ControlTuple,type OperatorReceipt} from '../../src/attachments/test-admission/activation-control';
import {ACTIVATION_CONTROL_DDL} from '../../src/attachments/test-admission/activation-control-schema';
import {RUN_LEDGER_DDL} from '../../src/attachments/test-admission/run-ledger-schema';

// Explicit SQL proof only. Never uses the fixed shared tooling schema.
describe('inert execution ledger in disposable owned PostgreSQL schema',()=>{
 const db=new SqlHarness(); let ledger:RunLedger; let controls:ActivationControlRepository; let serverNow:number;
 beforeAll(async()=>{await db.open();
  if(!/^phase22_test_[a-f0-9]{32}$/.test(db.schema))throw Error('unsafe proof schema');
  await db.pool.query(RUN_LEDGER_DDL.replace(/phase30_test_execution/g,db.schema));
  await db.pool.query(ACTIVATION_CONTROL_DDL.replace(/phase30_test_execution/g,db.schema));
  controls=new ActivationControlRepository({connect:async()=>{const c=await db.pool.connect();return{query:(text:string,values?:unknown[])=>c.query(text.replace(/phase30_test_execution/g,db.schema),values),release:()=>c.release()};}} as unknown as Pool);
  // SQL qualification is fixed in production. Only this test projects queries.
  ledger=new RunLedger({connect:async()=>{const c=await db.pool.connect();return {
   query:(text:string,values?:unknown[])=>c.query(text.replace(/phase30_test_execution/g,db.schema),values),release:()=>c.release(),
  };}} as unknown as Pool);
 },30000);
 // Expiry authority is PostgreSQL; host clock skew must not invalidate fixtures.
 beforeEach(async()=>{serverNow=((await db.pool.query('SELECT clock_timestamp() t')).rows[0].t as Date).getTime();});
 afterAll(async()=>db.close());
 const table=(name:string)=>'"'+db.schema+'".'+name;
 function plan(overrides:Partial<PreparedRun>={}):PreparedRun{return {runId:randomUUID(),activationId:randomUUID(),manifestSha256:createHash('sha256').update(randomUUID()).digest('hex'),sourceSha:'b'.repeat(40),notBefore:new Date(serverNow-1000).toISOString(),expiresAt:new Date(serverNow+60000).toISOString(),limits:{...RUN_LIMITS,authenticatedRequests:1},slots:[{key:'upload.source',operationKey:'upload',role:'SOURCE_OBJECT',id:randomUUID(),attachmentId:randomUUID()}],...overrides};}
 it('allows only one activation, including across ledger instances/restarts',async()=>{
  const p=plan();await ledger.prepare(p);
  const result=await Promise.allSettled([ledger.activate(p.runId,p.activationId,randomUUID()),ledger.activate(p.runId,p.activationId,randomUUID())]);
  expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 });
 it('commits burns and charges before caller abort; concurrent budgets never overshoot',async()=>{
  const p=plan();await ledger.prepare(p);const active=await ledger.activate(p.runId,p.activationId,randomUUID());
  const request={operationKey:'upload',slots:[{key:'upload.source',role:'SOURCE_OBJECT' as const}],charges:{authenticatedRequests:1}};
  const results=await Promise.allSettled([ledger.reserve(active,request),ledger.reserve(active,request)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const c=await db.pool.connect();await c.query('BEGIN');await c.query('ROLLBACK');c.release();
  const row=(await db.pool.query('SELECT counters FROM '+table('runs')+' WHERE run_id=$1',[p.runId])).rows[0];
  expect(row.counters.authenticatedRequests).toBe(1);
  expect((await db.pool.query('SELECT state FROM '+table('slots')+' WHERE run_id=$1',[p.runId])).rows[0].state).toBe('BURNED');
 });
 it('rejects wrong roles and duplicate identity slots without partial preparation',async()=>{
  const p=plan();p.slots.push({...p.slots[0],key:'other'});await expect(ledger.prepare(p)).rejects.toThrow('TEST_ADMISSION_LEDGER');
  expect((await db.pool.query('SELECT 1 FROM '+table('runs')+' WHERE run_id=$1',[p.runId])).rowCount).toBe(0);
  const q=plan();await ledger.prepare(q);const active=await ledger.activate(q.runId,q.activationId,randomUUID());
  await expect(ledger.reserve(active,{operationKey:'upload',slots:[{key:'upload.source',role:'PUT_CLAIM'}],charges:{authenticatedRequests:1}})).rejects.toThrow('TEST_ADMISSION_LEDGER');
 });
 it('uses server expiry and never resumes expired authority',async()=>{
  const now=(await db.pool.query('SELECT clock_timestamp() t')).rows[0].t as Date;
  const p=plan({notBefore:new Date(now.getTime()-100).toISOString(),expiresAt:new Date(now.getTime()+10000).toISOString()});
  await ledger.prepare(p);const active=await ledger.activate(p.runId,p.activationId,randomUUID());
  await db.pool.query('SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM $1::timestamptz-clock_timestamp()))+0.05)',[p.expiresAt]);
  await expect(ledger.reserve(active,{operationKey:'upload',slots:[],charges:{authenticatedRequests:1}})).rejects.toThrow('TEST_ADMISSION_LEDGER');
 },30000);
 it('enforces slot UUID uniqueness across runs and roles atomically',async()=>{
  const p=plan();await ledger.prepare(p);const q=plan();q.slots[0].id=p.slots[0].id;q.slots[0].role='PUT_CLAIM';
  await expect(ledger.prepare(q)).rejects.toThrow('TEST_ADMISSION_LEDGER');
  expect((await db.pool.query('SELECT 1 FROM '+table('runs')+' WHERE run_id=$1',[q.runId])).rowCount).toBe(0);
 });
 it('cannot reprepare an immutable manifest under fresh run/activation IDs',async()=>{
  const p=plan();await ledger.prepare(p);const q=plan({manifestSha256:p.manifestSha256});
  await expect(ledger.prepare(q)).rejects.toThrow('TEST_ADMISSION_LEDGER');
 });
 it('serializes every separate global budget across concurrent requests',async()=>{
  for(const axis of Object.keys(RUN_LIMITS) as (keyof typeof RUN_LIMITS)[]){
   const anon=axis==='anonymousRequests'||axis==='anonymousEgressBytes';
   const p=plan({limits:{...RUN_LIMITS,authenticatedRequests:3,anonymousRequests:3,[axis]:1}});
   await ledger.prepare(p);const active=await ledger.activate(p.runId,p.activationId,randomUUID());
   const charges={ [anon?'anonymousRequests':'authenticatedRequests']:1,[axis]:1 };
   const attempt=()=>ledger.reserve(active,{operationKey:'read',slots:[],charges});
   const outcomes=await Promise.allSettled([attempt(),attempt()]);
   expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
   expect((await db.pool.query('SELECT counters FROM '+table('runs')+' WHERE run_id=$1',[p.runId])).rows[0].counters[axis]).toBe(1);
  }
 },60000);
 it('direct SQL cannot rewrite identities, lower counters, settle without proof or delete debt',async()=>{
  const p=plan();await ledger.prepare(p);const active=await ledger.activate(p.runId,p.activationId,randomUUID());
  await ledger.reserve(active,{operationKey:'upload',slots:[{key:'upload.source',role:'SOURCE_OBJECT'}],charges:{authenticatedRequests:1}});
  for(const statement of [
   `UPDATE ${table('runs')} SET manifest_sha256=repeat('c',64) WHERE run_id=$1`,
   `UPDATE ${table('runs')} SET counters=jsonb_set(counters,'{authenticatedRequests}','0') WHERE run_id=$1`,
   `UPDATE ${table('runs')} SET state='PREPARED' WHERE run_id=$1`,
   `UPDATE ${table('runs')} SET counters='1'::jsonb WHERE run_id=$1`,
   `UPDATE ${table('runs')} SET counters='null'::jsonb WHERE run_id=$1`,
   `UPDATE ${table('runs')} SET counters='[]'::jsonb WHERE run_id=$1`,
   `UPDATE ${table('runs')} SET counters='"private"'::jsonb WHERE run_id=$1`,
   `UPDATE ${table('runs')} SET counters=counters||'{"unknown":1}'::jsonb WHERE run_id=$1`,
   `UPDATE ${table('runs')} SET counters=jsonb_set(counters,'{authenticatedRequests}','1.5') WHERE run_id=$1`,
   `UPDATE ${table('runs')} SET counters=jsonb_set(counters,'{authenticatedRequests}','121') WHERE run_id=$1`,
   `UPDATE ${table('slots')} SET state='SETTLED' WHERE run_id=$1`,
   `UPDATE ${table('slots')} SET role='PUT_CLAIM' WHERE run_id=$1`,
   `UPDATE ${table('slots')} SET operation_key='foreign' WHERE run_id=$1`,
   `DELETE FROM ${table('slots')} WHERE run_id=$1`, `DELETE FROM ${table('runs')} WHERE run_id=$1`,
  ])await expect(db.pool.query(statement,[p.runId])).rejects.toThrow();
  await expect(db.pool.query('TRUNCATE '+table('slots'))).rejects.toThrow();
  await expect(db.pool.query('TRUNCATE '+table('runs')+' CASCADE')).rejects.toThrow();
 });
 function coarsePlan(){return plan({limits:{...RUN_LIMITS,authenticatedRequests:2},requests:{candidates:[{key:'public-head',method:'HEAD',path:'/api/v1/attachments/'+randomUUID()+'/content',authClass:'AUTH',ingressBytes:0,egressBytes:200}],attempts:[{key:'head-a',candidateKey:'public-head'},{key:'head-b',candidateKey:'public-head'}]}});}
 it('exposes only original committed candidate facts until the request is consumed',async()=>{
  const p=coarsePlan(),expected={...p.requests!.candidates[0]};await ledger.prepare(p);const active=await ledger.activate(p.runId,p.activationId,randomUUID()),receipt=await ledger.reserveRequest(active,'public-head');
  p.requests!.candidates[0].egressBytes=1;p.requests!.candidates[0].path='/not-the-committed-route';
  const actual=ledger.requireRequestCandidate(receipt);expect(actual).toEqual(expected);expect(Object.isFrozen(actual)).toBe(true);expect(Object.keys(receipt).sort()).toEqual(['attemptKey','candidateKey','runId']);
  expect(()=>ledger.requireRequestCandidate({...receipt})).toThrow('TEST_ADMISSION_LEDGER');expect(()=>new RunLedger(db.pool).requireRequestCandidate(receipt)).toThrow('TEST_ADMISSION_LEDGER');
  await expect(ledger.bindOperation(receipt,'nonexistent')).rejects.toThrow('TEST_ADMISSION_LEDGER');expect(()=>ledger.requireRequestCandidate(receipt)).toThrow('TEST_ADMISSION_LEDGER');
  expect((await db.pool.query('SELECT counters FROM '+table('runs')+' WHERE run_id=$1',[p.runId])).rows[0].counters).toMatchObject({authenticatedRequests:1,authenticatedEgressBytes:200});
 });
 it('retains a committed reservation without registering candidate authority after actual lost acknowledgement',async()=>{
  let uncertain=false;const owner=new RunLedger({connect:async()=>{const c=await db.pool.connect();return{query:async(sql:string,values?:unknown[])=>{const result=await c.query(sql.replace(/phase30_test_execution/g,db.schema),values);if(sql==='COMMIT'&&uncertain)throw Error('synthetic lost acknowledgement');return result;},release:()=>c.release()};}} as unknown as Pool);
  const p=coarsePlan();await owner.prepare(p);const active=await owner.activate(p.runId,p.activationId,randomUUID());uncertain=true;await expect(owner.reserveRequest(active,'public-head')).rejects.toThrow('TEST_ADMISSION_LEDGER');
  const row=(await db.pool.query('SELECT attempt_key,candidate_key FROM '+table('request_attempts')+" WHERE run_id=$1 AND state='RESERVED'",[p.runId])).rows[0];expect(row).toBeDefined();expect(()=>owner.requireRequestCandidate({runId:p.runId,attemptKey:row.attempt_key,candidateKey:row.candidate_key})).toThrow('TEST_ADMISSION_LEDGER');expect((await db.pool.query('SELECT counters FROM '+table('runs')+' WHERE run_id=$1',[p.runId])).rows[0].counters).toMatchObject({authenticatedRequests:1,authenticatedEgressBytes:200});
 });
 it('durably reserves finite request ceilings before parsing without burning product slots or refunding failures',async()=>{
  const p=coarsePlan();await ledger.prepare(p);const active=await ledger.activate(p.runId,p.activationId,randomUUID());
  const results=await Promise.allSettled(Array.from({length:3},()=>ledger.reserveRequest(active,'public-head')));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2);
  const row=(await db.pool.query('SELECT counters,preparation_sealed FROM '+table('runs')+' WHERE run_id=$1',[p.runId])).rows[0];
  expect(row.preparation_sealed).toBe(true);expect(row.counters).toEqual({authenticatedRequests:2,anonymousRequests:0,ingressBytes:0,authenticatedEgressBytes:400,anonymousEgressBytes:0,processingAttempts:0});
  expect((await db.pool.query('SELECT state FROM '+table('slots')+' WHERE run_id=$1',[p.runId])).rows[0].state).toBe('AVAILABLE');
  expect((await db.pool.query('SELECT state FROM '+table('request_attempts')+' WHERE run_id=$1',[p.runId])).rows.every(r=>r.state==='RESERVED')).toBe(true);
  // A cancelled/malformed caller has no refund/settlement API; every retry burns
  // another prelisted attempt. This proof invokes no parser/HTTP/provider.
  await expect(ledger.reserveRequest(active,'public-head')).rejects.toThrow('TEST_ADMISSION_LEDGER');
 });
 it('rejects aggregate coarse-ceiling overcommit and leaves no partially prepared request inventory',async()=>{
  const p=coarsePlan();p.limits.authenticatedEgressBytes=399;
  await expect(ledger.prepare(p)).rejects.toThrow('TEST_ADMISSION_LEDGER');
  expect((await db.pool.query('SELECT 1 FROM '+table('runs')+' WHERE run_id=$1',[p.runId])).rowCount).toBe(0);
 });
 it('seals request inventory and blocks direct mutation, refunds, late insertion, legacy slot burns and truncate',async()=>{
  const p=coarsePlan();await ledger.prepare(p);
  await expect(db.pool.query('INSERT INTO '+table('request_attempts')+"(run_id,attempt_key,candidate_key) VALUES($1,'late','public-head')",[p.runId])).rejects.toThrow();
  await expect(db.pool.query('UPDATE '+table('runs')+' SET preparation_sealed=false WHERE run_id=$1',[p.runId])).rejects.toThrow();
  const active=await ledger.activate(p.runId,p.activationId,randomUUID());await ledger.reserveRequest(active,'public-head');
  for(const sql of [
   'UPDATE '+table('request_candidates')+' SET egress_bytes=1 WHERE run_id=$1',
   'DELETE FROM '+table('request_candidates')+' WHERE run_id=$1',
   'DELETE FROM '+table('request_attempts')+' WHERE run_id=$1',
   'UPDATE '+table('request_attempts')+" SET state='AVAILABLE',reserved_at=NULL,boot_id=NULL WHERE run_id=$1 AND state='RESERVED'",
   'UPDATE '+table('request_attempts')+" SET candidate_key='other' WHERE run_id=$1",
   'UPDATE '+table('runs')+" SET counters=jsonb_set(counters,'{authenticatedRequests}','2') WHERE run_id=$1",
   'UPDATE '+table('runs')+" SET counters=jsonb_set(counters,'{authenticatedEgressBytes}','0') WHERE run_id=$1",
   'UPDATE '+table('slots')+" SET state='BURNED' WHERE run_id=$1",
  ])await expect(db.pool.query(sql,[p.runId])).rejects.toThrow();
  await expect(ledger.reserve(active,{operationKey:'upload',slots:[],charges:{authenticatedRequests:1}})).rejects.toThrow('TEST_ADMISSION_LEDGER');
  for(const name of ['request_candidates','request_attempts'])await expect(db.pool.query('TRUNCATE '+table(name)+' CASCADE')).rejects.toThrow();
 });
 it('charges stored anonymous byte ceilings independently and cannot reuse an original handle after restart',async()=>{
  const p=coarsePlan();p.requests!.candidates[0].authClass='ANON';p.requests!.candidates[0].egressBytes=300;
  await ledger.prepare(p);const active=await ledger.activate(p.runId,p.activationId,randomUUID());await ledger.reserveRequest(active,'public-head');
  const row=(await db.pool.query('SELECT counters FROM '+table('runs')+' WHERE run_id=$1',[p.runId])).rows[0];expect(row.counters.anonymousRequests).toBe(1);expect(row.counters.anonymousEgressBytes).toBe(300);expect(row.counters.authenticatedRequests).toBe(0);
  await expect(new RunLedger(db.pool).reserveRequest(active,'public-head')).rejects.toThrow('TEST_ADMISSION_LEDGER');
  await expect(ledger.reserveRequest({...active},'public-head')).rejects.toThrow('TEST_ADMISSION_LEDGER');
 });

 it('expires request reservation naturally without renewal or clearing earlier charges',async()=>{
  const now=(await db.pool.query('SELECT clock_timestamp() t')).rows[0].t as Date;
  const p=coarsePlan();p.notBefore=new Date(now.getTime()-100).toISOString();p.expiresAt=new Date(now.getTime()+10000).toISOString();
  await ledger.prepare(p);const active=await ledger.activate(p.runId,p.activationId,randomUUID());await ledger.reserveRequest(active,'public-head');
  await db.pool.query('SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM $1::timestamptz-clock_timestamp()))+0.05)',[p.expiresAt]);
  await expect(ledger.reserveRequest(active,'public-head')).rejects.toThrow('TEST_ADMISSION_LEDGER');
  const row=(await db.pool.query('SELECT counters FROM '+table('runs')+' WHERE run_id=$1',[p.runId])).rows[0];expect(row.counters.authenticatedRequests).toBe(1);expect(row.counters.authenticatedEgressBytes).toBe(200);
 },30000);

 function bindingPlan():PreparedRun {
  const p=plan();const attachmentId=p.slots[0].attachmentId!;
  p.requests={candidates:[{key:'upload',method:'PUT',path:'/api/v1/attachments/'+attachmentId+'/content',authClass:'AUTH',ingressBytes:200,egressBytes:0}],attempts:[{key:'attempt-a',candidateKey:'upload'}]};
  p.bindings={operations:[{key:'upload',attachmentId,ingressBytes:100,egressBytes:0,processingAttempts:1,slotKeys:['upload.source']}],edges:[{attemptKey:'attempt-a',operationKey:'upload'}]};
  return p;
 }
 it('binds the original reserved request once, preserving byte charges and recording processing/debt',async()=>{
  const p=bindingPlan();await ledger.prepare(p);const active=await ledger.activate(p.runId,p.activationId,randomUUID());
  const request=await ledger.reserveRequest(active,'upload'),bound=await ledger.bindOperation(request,'upload');
  expect(bound.slots).toEqual(p.slots);expect(Object.isFrozen(bound.slots[0])).toBe(true);
  await expect(ledger.bindOperation(request,'upload')).rejects.toThrow('TEST_ADMISSION_LEDGER');
  const row=(await db.pool.query('SELECT counters,recovery_debt FROM '+table('runs')+' WHERE run_id=$1',[p.runId])).rows[0];
  expect(row.counters).toEqual({authenticatedRequests:1,anonymousRequests:0,ingressBytes:200,authenticatedEgressBytes:0,anonymousEgressBytes:0,processingAttempts:1});expect(row.recovery_debt).toBe(true);
  expect((await db.pool.query('SELECT state,bound_operation_key FROM '+table('request_attempts')+' WHERE run_id=$1',[p.runId])).rows[0]).toEqual({state:'BOUND',bound_operation_key:'upload'});
 });
 it('serializes competing distinct attempts for one operation with no request refunds',async()=>{
  const p=bindingPlan();p.limits.authenticatedRequests=2;p.requests!.attempts.push({key:'attempt-b',candidateKey:'upload'});p.bindings!.edges.push({attemptKey:'attempt-b',operationKey:'upload'});
  await ledger.prepare(p);const active=await ledger.activate(p.runId,p.activationId,randomUUID());
  const requests=await Promise.all([ledger.reserveRequest(active,'upload'),ledger.reserveRequest(active,'upload')]);
  const outcomes=await Promise.allSettled(requests.map(r=>ledger.bindOperation(r,'upload')));expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const row=(await db.pool.query('SELECT counters FROM '+table('runs')+' WHERE run_id=$1',[p.runId])).rows[0];expect(row.counters.authenticatedRequests).toBe(2);expect(row.counters.ingressBytes).toBe(400);expect(row.counters.processingAttempts).toBe(1);
 });
 it('does not grant reconstructed/restarted handles or undo accounting when exact matching fails',async()=>{
  const p=bindingPlan();await ledger.prepare(p);const active=await ledger.activate(p.runId,p.activationId,randomUUID()),request=await ledger.reserveRequest(active,'upload');
  await expect(ledger.bindOperation({...request},'upload')).rejects.toThrow('TEST_ADMISSION_LEDGER');
  await expect(new RunLedger(db.pool).bindOperation(request,'upload')).rejects.toThrow('TEST_ADMISSION_LEDGER');
  await expect(ledger.bindOperation(request,'unlisted')).rejects.toThrow('TEST_ADMISSION_LEDGER');
  await expect(ledger.bindOperation(request,'upload')).rejects.toThrow('TEST_ADMISSION_LEDGER');
  expect((await db.pool.query('SELECT state FROM '+table('request_attempts')+' WHERE run_id=$1',[p.runId])).rows[0].state).toBe('RESERVED');
  expect((await db.pool.query('SELECT state FROM '+table('slots')+' WHERE run_id=$1',[p.runId])).rows[0].state).toBe('AVAILABLE');
  expect((await db.pool.query('SELECT counters FROM '+table('runs')+' WHERE run_id=$1',[p.runId])).rows[0].counters.ingressBytes).toBe(200);
 });
 it('rejects direct partial binding, invented slot authority and sealed inventory tampering',async()=>{
  const p=bindingPlan();await ledger.prepare(p);const active=await ledger.activate(p.runId,p.activationId,randomUUID()),request=await ledger.reserveRequest(active,'upload');
  for(const sql of [
   'UPDATE '+table('runs')+' SET operation_count=2 WHERE run_id=$1',
   'UPDATE '+table('bound_operations')+" SET ingress_bytes=0 WHERE run_id=$1",
   'UPDATE '+table('bound_operations')+" SET state='BOUND',bound_attempt_key='attempt-a' WHERE run_id=$1",
   'UPDATE '+table('request_attempts')+" SET state='BOUND',bound_operation_key='upload' WHERE run_id=$1",
   'UPDATE '+table('slots')+" SET state='BURNED' WHERE run_id=$1",
   'DELETE FROM '+table('operation_edges')+' WHERE run_id=$1',
   'UPDATE '+table('operation_slots')+" SET slot_key='unlisted' WHERE run_id=$1",
   'INSERT INTO '+table('operation_edges')+"(run_id,attempt_key,operation_key) VALUES($1,'attempt-a','upload')",
  ])await expect(db.pool.query(sql,[p.runId])).rejects.toThrow();
  for(const name of ['bound_operations','operation_edges','operation_slots'])await expect(db.pool.query('TRUNCATE '+table(name)+' CASCADE')).rejects.toThrow();
  await ledger.bindOperation(request,'upload');
  for(const sql of [
   'UPDATE '+table('runs')+" SET counters=jsonb_set(counters,'{processingAttempts}','0') WHERE run_id=$1",
   'UPDATE '+table('runs')+' SET recovery_debt=false WHERE run_id=$1',
   'UPDATE '+table('bound_operations')+" SET state='AVAILABLE',bound_attempt_key=NULL WHERE run_id=$1",
  ])await expect(db.pool.query(sql,[p.runId])).rejects.toThrow();
 });
 it('seals exact slot/edge coverage and rejects conservative processing overcommit before preparation',async()=>{
  for(const missing of ['coverage','processing']){const p=bindingPlan();if(missing==='coverage')p.bindings!.operations[0].slotKeys=[];else{p.limits.processingAttempts=1;p.limits.authenticatedRequests=2;p.requests!.attempts.push({key:'attempt-b',candidateKey:'upload'});p.bindings!.edges.push({attemptKey:'attempt-b',operationKey:'upload'});}
   await expect(ledger.prepare(p)).rejects.toThrow('TEST_ADMISSION_LEDGER');expect((await db.pool.query('SELECT 1 FROM '+table('runs')+' WHERE run_id=$1',[p.runId])).rowCount).toBe(0);
  }
 });
 it('expires reserved binding naturally while retaining the original consumed request budget',async()=>{
  const now=(await db.pool.query('SELECT clock_timestamp() t')).rows[0].t as Date,p=bindingPlan();p.notBefore=new Date(now.getTime()-100).toISOString();p.expiresAt=new Date(now.getTime()+10000).toISOString();
  await ledger.prepare(p);const active=await ledger.activate(p.runId,p.activationId,randomUUID()),request=await ledger.reserveRequest(active,'upload');
  await db.pool.query('SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM $1::timestamptz-clock_timestamp()))+0.05)',[p.expiresAt]);
  await expect(ledger.bindOperation(request,'upload')).rejects.toThrow('TEST_ADMISSION_LEDGER');
  const row=(await db.pool.query('SELECT counters FROM '+table('runs')+' WHERE run_id=$1',[p.runId])).rows[0];expect(row.counters.ingressBytes).toBe(200);expect(row.counters.processingAttempts).toBe(0);
 },30000);

 it('keeps controlled preparation blocked from legacy activation and direct SQL',async()=>{
  const p=plan();Object.assign(p,{activationControlRequired:true});await ledger.prepare(p);
  const row=(await db.pool.query('SELECT activation_control_required FROM '+table('runs')+' WHERE run_id=$1',[p.runId])).rows[0];expect(row.activation_control_required).toBe(true);
  await expect(ledger.activate(p.runId,p.activationId,randomUUID())).rejects.toThrow('TEST_ADMISSION_LEDGER');
  await expect(db.pool.query('UPDATE '+table('runs')+" SET state='ACTIVE',boot_id=$2 WHERE run_id=$1",[p.runId,randomUUID()])).rejects.toThrow();
  await expect(db.pool.query('UPDATE '+table('runs')+' SET activation_control_required=false WHERE run_id=$1',[p.runId])).rejects.toThrow();
  const legacy=plan();await ledger.prepare(legacy);await expect(db.pool.query('UPDATE '+table('runs')+' SET activation_control_required=true WHERE run_id=$1',[legacy.runId])).rejects.toThrow();
 });

 async function controlled(expiresInMs=60000):Promise<ControlTuple>{
  const now=((await db.pool.query('SELECT clock_timestamp() t')).rows[0].t as Date).getTime(),p=plan({activationControlRequired:true,notBefore:new Date(now-1000).toISOString(),expiresAt:new Date(now+expiresInMs).toISOString()});await ledger.prepare(p);
  return{runId:p.runId,activationId:p.activationId,sourceSha:p.sourceSha,manifestSha256:p.manifestSha256,service:'srv-dahnerh594qs73fp3420',branch:'dev',deploymentId:'dep-owned-proof',bootId:randomUUID(),notBefore:p.notBefore,expiresAt:p.expiresAt};
 }
 async function observation(t:ControlTuple):Promise<OperatorReceipt>{return{service:t.service,branch:t.branch,sha:t.sourceSha,manifestSha256:t.manifestSha256,deploymentId:t.deploymentId,bootId:t.bootId,observedAt:((await db.pool.query('SELECT clock_timestamp() t')).rows[0].t as Date).toISOString(),liveObserved:true,originalDisabledCommandObserved:true,allFourFlagsFalseObserved:true};}
 it('arms/stores once without ever activating, including concurrent contenders',async()=>{
  const t=await controlled(),arms=await Promise.allSettled([controls.arm(t),controls.arm(t)]);expect(arms.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const receipt=await observation(t),stores=await Promise.allSettled([controls.storeReceipt(t,receipt),controls.storeReceipt(t,receipt)]);expect(stores.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const out=await controls.inspectExact(t);expect(out).toMatchObject({tuple:t,runState:'PREPARED',state:'RECEIPT_STORED',receipt});expect(Object.isFrozen(out)).toBe(true);expect(Object.isFrozen(out!.receipt)).toBe(true);
  await expect(ledger.activate(t.runId,t.activationId,t.bootId)).rejects.toThrow('TEST_ADMISSION_LEDGER');
  await expect(db.pool.query('UPDATE '+table('runs')+" SET state='ACTIVE',boot_id=$2 WHERE run_id=$1",[t.runId,t.bootId])).rejects.toThrow();
 });
 it('compares exact original tuple and cannot arm legacy runs or reuse a boot',async()=>{
  const t=await controlled();for(const patch of [{activationId:randomUUID()},{sourceSha:'c'.repeat(40)},{manifestSha256:'c'.repeat(64)},{expiresAt:new Date(Date.parse(t.expiresAt)+1000).toISOString()}])await expect(controls.arm({...t,...patch})).rejects.toThrow('TEST_ACTIVATION_CONTROL');
  await controls.arm(t);expect(await controls.inspectExact({...t,bootId:randomUUID()})).toBeNull();
  const other=await controlled();await expect(controls.arm({...other,bootId:t.bootId})).rejects.toThrow('TEST_ACTIVATION_CONTROL');
  const p=plan();await ledger.prepare(p);await expect(controls.arm({...t,runId:p.runId,activationId:p.activationId,manifestSha256:p.manifestSha256,notBefore:p.notBefore,expiresAt:p.expiresAt,bootId:randomUUID()})).rejects.toThrow('TEST_ACTIVATION_CONTROL');
 });
 it('rejects stale/future/prearm receipt and exact-identity or procedural mismatches atomically',async()=>{
  const t=await controlled();await controls.arm(t);const receipt=await observation(t);
  for(const patch of [{observedAt:new Date(Date.parse(receipt.observedAt)+60000).toISOString()},{observedAt:new Date(Date.parse(receipt.observedAt)-300001).toISOString()},{deploymentId:'dep-other'},{bootId:randomUUID()},{manifestSha256:'d'.repeat(64)},{liveObserved:false},{allFourFlagsFalseObserved:false}])await expect(controls.storeReceipt(t,{...receipt,...patch} as OperatorReceipt)).rejects.toThrow('TEST_ACTIVATION_CONTROL');
  expect((await controls.inspectExact(t))!.state).toBe('ARMED');await controls.storeReceipt(t,await observation(t));
 });
 it('rejects control tuple/receipt/direct SQL mutation, deletion and truncation',async()=>{
  const t=await controlled();await controls.arm(t);
  for(const sql of [
   'UPDATE '+table('activation_controls')+" SET deployment_id='dep-other' WHERE run_id=$1",
   'UPDATE '+table('activation_controls')+" SET expires_at=expires_at+interval '1 second' WHERE run_id=$1",
   'UPDATE '+table('activation_controls')+" SET armed_at=armed_at-interval '1 second' WHERE run_id=$1",
   'UPDATE '+table('activation_controls')+" SET state='RECEIPT_STORED',receipt='{}'::jsonb WHERE run_id=$1",
   'DELETE FROM '+table('activation_controls')+' WHERE run_id=$1',
  ])await expect(db.pool.query(sql,[t.runId])).rejects.toThrow();
  await controls.storeReceipt(t,await observation(t));
  for(const sql of [
   'UPDATE '+table('activation_controls')+" SET receipt=jsonb_set(receipt,'{observedAt}',to_jsonb(clock_timestamp())) WHERE run_id=$1",
   'UPDATE '+table('activation_controls')+" SET state='ARMED',receipt=NULL,receipt_stored_at=NULL WHERE run_id=$1",
   'UPDATE '+table('activation_controls')+" SET boot_id=$2 WHERE run_id=$1",
  ])await expect(db.pool.query(sql,sql.includes('$2')?[t.runId,randomUUID()]:[t.runId])).rejects.toThrow();
  await expect(db.pool.query('TRUNCATE '+table('activation_controls'))).rejects.toThrow();
 });
 it('uses database expiry after a blocked lock and retains inspectable facts without authority',async()=>{
  const t=await controlled(10000);await controls.arm(t);const receipt=await observation(t);
  // Leave less than the 2s lock timeout so the waiter acquires the lock after expiry.
  await db.pool.query('SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM $1::timestamptz-clock_timestamp())-1.2))',[t.expiresAt]);
  const c=await db.pool.connect();await c.query('BEGIN');await c.query('SELECT run_id FROM '+table('runs')+' WHERE run_id=$1 FOR UPDATE',[t.runId]);
  const pending=controls.storeReceipt(t,receipt).then(()=>true,()=>false);
  try{await db.pool.query('SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM $1::timestamptz-clock_timestamp()))+0.05)',[t.expiresAt]);}finally{await c.query('ROLLBACK');c.release();}
  expect(await pending).toBe(false);const snapshot=await controls.inspectExact(t);expect(snapshot!.state).toBe('ARMED');expect(snapshot!.runState).toBe('PREPARED');await expect(controls.storeReceipt(t,receipt)).rejects.toThrow('TEST_ACTIVATION_CONTROL');await expect(controls.arm(t)).rejects.toThrow('TEST_ACTIVATION_CONTROL');
 },30000);

 async function readyControl(expiresInMs=60000){const t=await controlled(expiresInMs);await controls.arm(t);await controls.storeReceipt(t,await observation(t));return t;}
 function anotherLedger(){return new RunLedger({connect:async()=>{const c=await db.pool.connect();return{query:(text:string,values?:unknown[])=>c.query(text.replace(/phase30_test_execution/g,db.schema),values),release:()=>c.release()};}} as unknown as Pool);}
 it('atomically consumes the receipt and activates once across independent ledger instances',async()=>{
  const t=await readyControl(),other=anotherLedger(),outcomes=await Promise.allSettled([ledger.activateControlled(t),other.activateControlled(t)]);expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const index=outcomes.findIndex(r=>r.status==='fulfilled'),handle=(outcomes[index] as PromiseFulfilledResult<Awaited<ReturnType<RunLedger['activateControlled']>>>).value,owner=index===0?ledger:other;
  expect(owner.requireControlled(handle)).toBe(handle);expect(handle).toMatchObject({...t,mode:'CONTROLLED'});expect(()=>owner.requireControlled({...handle})).toThrow();expect(()=>(index===0?other:ledger).requireControlled(handle)).toThrow();
  const snapshot=await controls.inspectExact(t);expect(snapshot).toMatchObject({state:'CONSUMED',runState:'ACTIVE'});expect(snapshot!.consumedAt).not.toBeNull();expect(Object.isFrozen(snapshot!.receipt)).toBe(true);
  await expect(ledger.activateControlled(t)).rejects.toThrow('TEST_ADMISSION_LEDGER');await expect(ledger.activate(t.runId,t.activationId,t.bootId)).rejects.toThrow('TEST_ADMISSION_LEDGER');
 });
 it('rejects direct half transitions at commit without leaving partial consumption',async()=>{
  const t=await readyControl(),c=await db.pool.connect();await c.query('BEGIN');
  try{expect((await c.query('UPDATE '+table('activation_controls')+" SET state='CONSUMED' WHERE run_id=$1",[t.runId])).rowCount).toBe(1);await expect(c.query('COMMIT')).rejects.toThrow();}finally{await c.query('ROLLBACK');c.release();}
  expect(await controls.inspectExact(t)).toMatchObject({state:'RECEIPT_STORED',runState:'PREPARED',consumedAt:null});
  await expect(db.pool.query('UPDATE '+table('runs')+" SET state='ACTIVE',boot_id=$2 WHERE run_id=$1",[t.runId,t.bootId])).rejects.toThrow();
  await ledger.activateControlled(t);
 });
 it('rejects wrong original tuple, replacement boots and legacy runs without consuming receipt',async()=>{
  const t=await readyControl();for(const patch of [{bootId:randomUUID()},{deploymentId:'dep-other'},{sourceSha:'c'.repeat(40)},{manifestSha256:'c'.repeat(64)},{expiresAt:new Date(Date.parse(t.expiresAt)+1).toISOString()}])await expect(ledger.activateControlled({...t,...patch})).rejects.toThrow('TEST_ADMISSION_LEDGER');
  expect(await controls.inspectExact(t)).toMatchObject({state:'RECEIPT_STORED',runState:'PREPARED',consumedAt:null});
  const p=plan();await ledger.prepare(p);await expect(ledger.activateControlled({...t,runId:p.runId,activationId:p.activationId,manifestSha256:p.manifestSha256,notBefore:p.notBefore,expiresAt:p.expiresAt})).rejects.toThrow('TEST_ADMISSION_LEDGER');
  const legacy=await ledger.activate(p.runId,p.activationId,randomUUID());expect(()=>ledger.requireControlled(legacy)).toThrow();await ledger.activateControlled(t);
 });
 it('keeps consumed evidence immutable and supports later legitimate terminal closure',async()=>{
  const t=await readyControl();await ledger.activateControlled(t);const before=await controls.inspectExact(t);
  for(const sql of [
   'UPDATE '+table('activation_controls')+" SET state='RECEIPT_STORED',consumed_at=NULL WHERE run_id=$1",
   'UPDATE '+table('activation_controls')+" SET consumed_at=consumed_at+interval '1 millisecond' WHERE run_id=$1",
   'UPDATE '+table('activation_controls')+" SET receipt=jsonb_set(receipt,'{sha}',to_jsonb(repeat('c',40))) WHERE run_id=$1",
  ])await expect(db.pool.query(sql,[t.runId])).rejects.toThrow();
  await db.pool.query('UPDATE '+table('runs')+" SET state='CLOSED' WHERE run_id=$1",[t.runId]);const after=await controls.inspectExact(t);expect(after).toMatchObject({state:'CONSUMED',runState:'CLOSED',consumedAt:before!.consumedAt,receipt:before!.receipt});await expect(ledger.activateControlled(t)).rejects.toThrow();
 });
 it('issues no handle on uncertain actual commit and never reconstructs one from durable inspection',async()=>{
  const t=await readyControl();let connects=0;const uncertain=new RunLedger({connect:async()=>{connects++;const c=await db.pool.connect();return{query:async(text:string,values?:unknown[])=>{const result=await c.query(text.replace(/phase30_test_execution/g,db.schema),values);if(text==='COMMIT')throw Error('lost commit acknowledgement');return result;},release:()=>c.release()};}} as unknown as Pool);
  await expect(uncertain.activateControlled(t)).rejects.toThrow('TEST_ADMISSION_LEDGER');expect(connects).toBe(1);expect(await controls.inspectExact(t)).toMatchObject({state:'CONSUMED',runState:'ACTIVE'});await expect(anotherLedger().activateControlled(t)).rejects.toThrow();const reconstructed={...t,mode:'CONTROLLED'};expect(()=>uncertain.requireControlled(reconstructed)).toThrow();
 });
 it('rechecks original expiry after waiting for locks without consuming or renewing',async()=>{
  const t=await readyControl(10000);await db.pool.query('SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM $1::timestamptz-clock_timestamp())-1.2))',[t.expiresAt]);const c=await db.pool.connect();await c.query('BEGIN');await c.query('SELECT run_id FROM '+table('runs')+' WHERE run_id=$1 FOR UPDATE',[t.runId]);
  const pending=ledger.activateControlled(t).then(()=>true,()=>false);try{await db.pool.query('SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM $1::timestamptz-clock_timestamp()))+0.05)',[t.expiresAt]);}finally{await c.query('ROLLBACK');c.release();}expect(await pending).toBe(false);expect(await controls.inspectExact(t)).toMatchObject({state:'RECEIPT_STORED',runState:'PREPARED',consumedAt:null});
 },30000);

});
