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
