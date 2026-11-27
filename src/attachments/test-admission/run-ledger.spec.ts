import { RunLedger } from './run-ledger';
import { RUN_LEDGER_DDL } from './run-ledger-schema';
import {RUN_LIMITS,type PreparedRun} from './run-ledger';
import type {Pool} from 'pg';
const runId='10000000-0000-4000-8000-000000000001',activationId='10000000-0000-4000-8000-000000000002',bootId='10000000-0000-4000-8000-000000000003';
const plan=():PreparedRun=>({runId,activationId,manifestSha256:'a'.repeat(64),sourceSha:'b'.repeat(40),notBefore:'2026-11-10T00:00:00.000Z',expiresAt:'2026-11-10T00:10:00.000Z',limits:{...RUN_LIMITS},slots:[{key:'source',operationKey:'upload',role:'SOURCE_OBJECT',id:'10000000-0000-4000-8000-000000000004'}]});
function pool(){const query=jest.fn(async(_sql:string,_values?:unknown[])=>({rowCount:1,rows:[]})),release=jest.fn();return {query,release,connect:jest.fn(async()=>({query,release}))};}

describe('inert TEST execution ledger', () => {
  it('exports explicit tooling DDL without connecting or installing', () => {
    expect(typeof RunLedger).toBe('function');
    expect(RUN_LEDGER_DDL).toContain('phase30_test_execution.runs');
    expect(RUN_LEDGER_DDL).not.toMatch(/public\.|attachment_quota_counters|DROP SCHEMA/i);
    expect(RUN_LEDGER_DDL).toContain('BEFORE TRUNCATE');
  });
  it('snapshots prepared facts before yielding and uses parameterized owned inserts',async()=>{
    const p=plan(),db=pool();db.connect.mockImplementationOnce(async()=>{p.runId='private';p.manifestSha256='changed';p.expiresAt='changed';p.slots[0].id='changed';p.limits.ingressBytes=1;return {query:db.query,release:db.release};});
    await new RunLedger(db as unknown as Pool).prepare(p);
    const insertion=db.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO phase30_test_execution.runs'))!;
    expect(insertion[1]!.slice(0,6)).toEqual([runId,activationId,'a'.repeat(64),'b'.repeat(40),'2026-11-10T00:00:00.000Z','2026-11-10T00:10:00.000Z']);
    expect(db.query.mock.calls.at(-1)![0]).toBe('COMMIT');expect(db.release).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid plans without connecting and never accepts reconstructed authority',async()=>{
    const db=pool(),ledger=new RunLedger(db as unknown as Pool),p=plan();p.slots[0].role='PRIVATE' as 'SOURCE_OBJECT';
    await expect(ledger.prepare(p)).rejects.toThrow('TEST_ADMISSION_LEDGER');
    await expect(ledger.reserve({runId,activationId,bootId},{operationKey:'upload',slots:[],charges:{authenticatedRequests:1}})).rejects.toThrow('TEST_ADMISSION_LEDGER');
    expect(db.connect).not.toHaveBeenCalled();
  });
  it('sanitizes SQL/connect failures and never retries an uncertain outcome',async()=>{
    const db=pool();db.query.mockRejectedValueOnce(Error('PRIVATE_DATABASE_DETAIL'));
    await expect(new RunLedger(db as unknown as Pool).activate(runId,activationId,bootId)).rejects.toThrow(/^TEST_ADMISSION_LEDGER$/);
    expect(db.connect).toHaveBeenCalledTimes(1);expect(db.query.mock.calls.at(-1)![0]).toBe('ROLLBACK');expect(db.release).toHaveBeenCalled();
  });
  it('prepares closed ASCII slot keys in binary order independent of host locale',async()=>{
    const p=plan(),db=pool();
    p.slots=['a_','a.','a-'].map((key,index)=>({...p.slots[0],key,id:'10000000-0000-4000-8000-00000000000'+(index+4)}));
    await new RunLedger(db as unknown as Pool).prepare(p);
    const order=db.query.mock.calls.filter(([sql])=>sql.includes('INSERT INTO phase30_test_execution.slots')).map(([,values])=>values![1]);
    expect(order).toEqual(['a-','a.','a_']);
  });
});

function deadlinePool(commitDelay = 0) {
  const query = jest.fn(async (sql: string) => {
      if (sql === "COMMIT" && commitDelay)
        jest.advanceTimersByTime(commitDelay);
      let rows: unknown[] = [];
      if (sql.includes("SELECT run_id")) rows = [{ run_id: runId }];
      if (sql.includes("SELECT attempt_key,candidate_key"))
        rows = [{ attempt_key: "attempt", candidate_key: "candidate" }];
      if (sql.includes("SELECT c.candidate_key"))
        rows = [
          {
            candidate_key: "candidate",
            method: "POST",
            path: "/api/v1/attachments",
            auth_class: "AUTH",
            ingress_bytes: "102400",
            egress_bytes: "0",
          },
        ];
      if (sql.includes("observed_at"))
        rows = [{ expires_at: new Date(2000), observed_at: new Date(1000) }];
      return { rowCount: 1, rows };
    }),
    release = jest.fn();
  return { query, connect: jest.fn(async () => ({ query, release })) };
}
describe("committed receipt monotonic body expiry", () => {
  afterEach(() => jest.useRealTimers());
  it("subtracts commit delay, ignores wall-clock changes and never changes receipt/candidate shape", async () => {
    jest.useFakeTimers();
    const p = deadlinePool(200),
      ledger = new RunLedger(p as unknown as Pool),
      active = await ledger.activate(runId, activationId, bootId),
      h = await ledger.reserveRequest(active, "candidate");
    expect(ledger.requireRequestBodyRemaining(h)).toBe(799);
    jest.setSystemTime(99999999);
    expect(ledger.requireRequestBodyRemaining(h)).toBe(799);
    jest.advanceTimersByTime(799);
    expect(ledger.requireRequestBodyRemaining(h)).toBe(0);
    expect(Object.keys(h).sort()).toEqual([
      "attemptKey",
      "candidateKey",
      "runId",
    ]);
    expect(ledger.requireRequestCandidate(h)).not.toHaveProperty("deadline");
  });
  it("rejects copies/foreign/consumed receipts and a COMMIT which outlives original expiry", async () => {
    jest.useFakeTimers();
    const p = deadlinePool(),
      ledger = new RunLedger(p as unknown as Pool),
      a = await ledger.activate(runId, activationId, bootId),
      h = await ledger.reserveRequest(a, "candidate");
    expect(() => ledger.requireRequestBodyRemaining({ ...h })).toThrow(
      "TEST_ADMISSION_LEDGER",
    );
    expect(() =>
      new RunLedger(p as unknown as Pool).requireRequestBodyRemaining(h),
    ).toThrow();
    await expect(ledger.bindOperation(h, "missing")).rejects.toThrow();
    expect(() => ledger.requireRequestBodyRemaining(h)).toThrow();
    const slow = deadlinePool(1100),
      other = new RunLedger(slow as unknown as Pool),
      b = await other.activate(runId, activationId, bootId);
    await expect(other.reserveRequest(b, "candidate")).rejects.toThrow(
      "TEST_ADMISSION_LEDGER",
    );
  });
});

it('prepares separate internal cleanup coverage without an HTTP edge or fake request',async()=>{const p=plan(),db=pool(),roles=['UPLOAD_OWNER','SOURCE_OBJECT','SOURCE_ATTEMPT','PUT_CLAIM','PUT_SUPERVISION'] as const,attachmentId='10000000-0000-4000-8000-000000000009';p.activationControlRequired=true;p.slots=roles.map((role,i)=>({key:'http-'+i,operationKey:'upload',role,id:'10000000-0000-4000-8000-00000000001'+i,attachmentId}));p.slots.push({key:'internal-job',operationKey:'source-cleanup',role:'CLEANUP_JOB',id:'10000000-0000-4000-8000-000000000020',attachmentId});p.requests={candidates:[{key:'upload',method:'PUT',path:'/api/v1/attachments/'+attachmentId+'/content',authClass:'AUTH',ingressBytes:100,egressBytes:0}],attempts:[{key:'coarse',candidateKey:'upload'}]};p.bindings={operations:[{key:'upload',policyKey:'upload-policy',policyAttemptKey:'one',attachmentId,ingressBytes:100,egressBytes:0,processingAttempts:0,slotKeys:p.slots.slice(0,5).map(s=>s.key)}],edges:[{attemptKey:'coarse',operationKey:'upload'}]};p.internalCleanup=[{key:'source-cleanup',sourceOperationKey:'upload',attachmentId,objectId:p.slots[1].id,attemptId:p.slots[2].id,claimId:p.slots[3].id,supervisionId:p.slots[4].id,sha256:'b'.repeat(64),byteCount:100,jobSlotKey:'internal-job'}];await new RunLedger(db as unknown as Pool).prepare(p);expect(db.query.mock.calls.filter(([sql])=>sql.includes('INSERT INTO phase30_test_execution.internal_cleanup_entries'))).toHaveLength(1);expect(db.query.mock.calls.filter(([sql])=>sql.includes('INSERT INTO phase30_test_execution.operation_slots'))).toHaveLength(5);expect(RUN_LEDGER_DDL).toContain('internal_cleanup_count');expect(RUN_LEDGER_DDL).toContain('check_internal_cleanup_consistency');});
