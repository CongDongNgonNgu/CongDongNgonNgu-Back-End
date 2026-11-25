import {randomUUID,createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {SqlHarness} from '../phase22/sql-harness';
import {RunLedger, RUN_LIMITS, type PreparedRun} from '../../src/attachments/test-admission/run-ledger';
import {RUN_LEDGER_DDL} from '../../src/attachments/test-admission/run-ledger-schema';

// Explicit SQL proof only. Never uses the fixed shared tooling schema.
describe('inert execution ledger in disposable owned PostgreSQL schema',()=>{
 const db=new SqlHarness(); let ledger:RunLedger;
 beforeAll(async()=>{await db.open();
  if(!/^phase22_test_[a-f0-9]{32}$/.test(db.schema))throw Error('unsafe proof schema');
  await db.pool.query(RUN_LEDGER_DDL.replace(/phase30_test_execution/g,db.schema));
  // SQL qualification is fixed in production. Only this test projects queries.
  ledger=new RunLedger({connect:async()=>{const c=await db.pool.connect();return {
   query:(text:string,values?:unknown[])=>c.query(text.replace(/phase30_test_execution/g,db.schema),values),release:()=>c.release(),
  };}} as unknown as Pool);
 },30000);
 afterAll(async()=>db.close());
 const table=(name:string)=>'"'+db.schema+'".'+name;
 function plan(overrides:Partial<PreparedRun>={}):PreparedRun{return {runId:randomUUID(),activationId:randomUUID(),manifestSha256:createHash('sha256').update(randomUUID()).digest('hex'),sourceSha:'b'.repeat(40),notBefore:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),limits:{...RUN_LIMITS,authenticatedRequests:1},slots:[{key:'upload.source',operationKey:'upload',role:'SOURCE_OBJECT',id:randomUUID(),attachmentId:randomUUID()}],...overrides};}
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

});
