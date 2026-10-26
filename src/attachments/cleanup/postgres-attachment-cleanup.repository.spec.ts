import type { Pool, PoolClient } from 'pg';
import { PostgresAttachmentCleanupRepository } from './postgres-attachment-cleanup.repository';
import { AttachmentRetentionLedger } from '../retention/attachment-retention-ledger';
import type {AttachmentTerminalPurge} from '../retention/attachment-terminal-purge';
import {AttachmentLifecycleError} from '../lifecycle/attachment-lifecycle-ledger';

function scenario(fail = false) {
 let open = false, committed = false, rolledBack = false, released = false;
 const client = { query: jest.fn(async (sql: string) => {
  if (sql.startsWith('BEGIN')) open = true;
  if (sql === 'COMMIT') { open = false; committed = true; }
  if (sql === 'ROLLBACK') { open = false; rolledBack = true; }
  return {rows: [], rowCount: 0};
 }), release: jest.fn(() => {released = true;}) } as unknown as PoolClient;
 const pool = {connect: jest.fn(async () => client)} as unknown as Pool;
 const retention = {purge: jest.fn(async (received: PoolClient, limit: number) => {
  expect(received).toBe(client); expect(open).toBe(true);
  if (fail) throw Error('RETENTION_UNAVAILABLE');
  return {admissionsPurged: 1, rateCountersPurged: 1, used: 2, remaining: limit - 2};
 })} as unknown as AttachmentRetentionLedger;
 return {pool, retention, state: () => ({open, committed, rolledBack, released})};
}
describe('separate rate-only retention transaction in cleanup repository', () => {
 it('commits and releases retention locks before returning its consumed batch budget', async () => {
  const s = scenario();
  const repository = new PostgresAttachmentCleanupRepository(s.pool, undefined, s.retention);
  expect(await repository.purgeRetention(5)).toBe(2);
  expect(s.retention.purge).toHaveBeenCalledWith(expect.anything(), 5);
  expect(s.state()).toEqual({open:false, committed:true, rolledBack:false, released:true});
 });
 it('rolls back failed retention and releases the connection instead of leaving quota locks held', async () => {
  const s = scenario(true);
  await expect(new PostgresAttachmentCleanupRepository(s.pool, undefined, s.retention).purgeRetention(5)).rejects.toThrow('RETENTION_UNAVAILABLE');
  expect(s.state()).toEqual({open:false, committed:false, rolledBack:true, released:true});
 });
 it.each([0, -1, 21, 1.5])('rejects invalid budget %s before opening any transaction', async limit => {
  const s = scenario();
  await expect(new PostgresAttachmentCleanupRepository(s.pool, undefined, s.retention).purgeRetention(limit)).rejects.toThrow('ATTACHMENT_CLEANUP_BATCH_INVALID');
  expect(s.pool.connect).not.toHaveBeenCalled();
 });
});

function terminals(){
 const ids=Array.from({length:22},(_,i)=>'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'));
 const query=jest.fn(async(_sql:string,args:unknown[])=>({rows:ids.filter(id=>!args[0]||id>String(args[0])).slice(0,Number(args[1])).map(id=>({id}))}));
 const purgeOne=jest.fn(async(_id:string,_budget:number)=>({status:'INELIGIBLE' as string,used:0,required:0}));
 const repository=new PostgresAttachmentCleanupRepository({query} as unknown as Pool,undefined,undefined,{purgeOne} as unknown as AttachmentTerminalPurge);
 return {ids,query,purgeOne,repository};
}

describe('bounded fair terminal retention candidates',()=>{
 it('continues past ineligible and oversized graphs and counts actual deleted rows',async()=>{const s=terminals();s.purgeOne.mockResolvedValueOnce({status:'SKIPPED_BUDGET',used:0,required:21}).mockResolvedValueOnce({status:'INELIGIBLE',used:0,required:0}).mockResolvedValueOnce({status:'PURGED',used:6,required:6}).mockResolvedValueOnce({status:'PURGED',used:14,required:14});expect(await s.repository.purgeTerminals(20)).toBe(20);expect(s.purgeOne.mock.calls.map(c=>c[1])).toEqual([20,20,20,14]);expect(s.query.mock.calls[0][1]).toEqual([null,20]);await s.repository.purgeTerminals(20);expect(s.query.mock.calls[1][1]).toEqual([s.ids[3],20]);});
 it('limits candidate attempts, advances skipped graphs and wraps only on the next tick after an empty page',async()=>{const s=terminals();await s.repository.purgeTerminals(20);expect(s.purgeOne).toHaveBeenCalledTimes(20);await s.repository.purgeTerminals(20);expect(s.purgeOne).toHaveBeenCalledTimes(22);await s.repository.purgeTerminals(20);expect(s.purgeOne).toHaveBeenCalledTimes(22);expect(s.query).toHaveBeenCalledTimes(3);await s.repository.purgeTerminals(20);expect(s.query.mock.calls[3][1]).toEqual([null,20]);});
 it('advances an exact disappeared-candidate race but retains cursor on infrastructure failure',async()=>{const s=terminals();s.purgeOne.mockRejectedValueOnce(new AttachmentLifecycleError()).mockRejectedValueOnce(Error('DB_UNAVAILABLE'));await expect(s.repository.purgeTerminals(20)).rejects.toThrow('DB_UNAVAILABLE');await s.repository.purgeTerminals(20);expect(s.query.mock.calls[1][1]).toEqual([s.ids[0],20]);});
 it('does not admit more candidates after stop while one atomic purge is in flight',async()=>{const s=terminals();let active=true;s.purgeOne.mockImplementationOnce(async()=>{active=false;return {status:'PURGED',used:6,required:6};});expect(await s.repository.purgeTerminals(20,()=>active)).toBe(6);expect(s.purgeOne).toHaveBeenCalledTimes(1);});
 it('rejects invalid or excessive row counts and never advances a rejected receipt',async()=>{const s=terminals();s.purgeOne.mockResolvedValueOnce({status:'PURGED',used:21,required:21});await expect(s.repository.purgeTerminals(20)).rejects.toThrow('ATTACHMENT_CLEANUP_BATCH_INVALID');await s.repository.purgeTerminals(20);expect(s.query.mock.calls[1][1]).toEqual([null,20]);});
 it('rejects invalid budgets before selecting candidates',async()=>{const s=terminals();await expect(s.repository.purgeTerminals(0)).rejects.toThrow('ATTACHMENT_CLEANUP_BATCH_INVALID');expect(s.query).not.toHaveBeenCalled();});
});
