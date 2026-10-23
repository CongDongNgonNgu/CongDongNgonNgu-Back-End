import type {PoolClient} from 'pg';
import {AttachmentQuotaLedger} from './attachment-quota-ledger';

const actor='11111111-1111-4111-8111-111111111111';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
function fixture(){
 const entered=deferred(),release=deferred();let xid='42',first=true,rejectUpdate=false;
 const attempts:string[]=[];
 const query=jest.fn(async(sql:string,values?:unknown[])=>{
  if(sql.startsWith('SELECT pg_current')){if(first){first=false;entered.resolve();await release.promise;}return {rows:[{id:xid}]};}
  if(sql.startsWith('INSERT'))attempts.push(`${values![0]}:${values![2]}`);
  return {rowCount:rejectUpdate?0:1,rows:[{used:1}]};
 });
 return {client:{query} as unknown as PoolClient,query,entered,release,attempts,newTransaction(){xid='43';rejectUpdate=false;},rejectUpdate(){rejectUpdate=true;}};
}

describe('attachment quota transaction-wide lock ordering',()=>{
 it.each(['reservation','upload'] as const)('serializes concurrent calls across ledger instances when %s starts first',async first=>{
  const f=fixture(),a=new AttachmentQuotaLedger(),b=new AttachmentQuotaLedger();
  const reserve=()=>a.changeReservation(f.client,actor,1024,1),upload=()=>b.changeSlots(f.client,actor,'upload',1);
  const one=first==='reservation'?reserve():upload();await f.entered.promise;
  const two=first==='reservation'?upload():reserve();
  const all=Promise.allSettled([one,two]);await Promise.resolve();await Promise.resolve();
  const callsWhileFirstBlocked=f.query.mock.calls.length;
  f.release.resolve();const result=await all;
  expect(callsWhileFirstBlocked).toBe(1);
  expect(result.map(r=>r.status)).toEqual(['fulfilled','rejected']);
  expect(result[1]).toMatchObject({reason:{code:'ATTACHMENT_QUOTA_LOCK_ORDER'}});
  expect(f.attempts).toEqual(first==='reservation'?['ACTOR:bytes','DEPLOYMENT:bytes','DEPLOYMENT:metadata']:['ACTOR:upload','DEPLOYMENT:upload']);
 });
 it('skips all queued SQL after failure and resets only for a new transaction',async()=>{
  const f=fixture(),ledger=new AttachmentQuotaLedger();f.rejectUpdate();
  const one=ledger.changeReservation(f.client,actor,1024,1);await f.entered.promise;
  const two=ledger.changeSlots(f.client,actor,'upload',1),three=ledger.changeReservation(f.client,actor,1024,1);
  const all=Promise.allSettled([one,two,three]);f.release.resolve();
  expect((await all).map(r=>r.status)).toEqual(['rejected','rejected','rejected']);
  expect(f.query.mock.calls).toHaveLength(3);
  await expect(ledger.changeReservation(f.client,actor,1024,1)).rejects.toThrow();
  expect(f.attempts).toEqual(['ACTOR:bytes']);
  f.newTransaction();await expect(ledger.changeReservation(f.client,actor,1024,1)).resolves.toBeUndefined();
 });
});
