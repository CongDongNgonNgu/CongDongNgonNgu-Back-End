import {Readable} from 'node:stream';
import type {PoolClient} from 'pg';
import {AttachmentPutSession} from './attachment-put-session';
import {AttachmentObjectLedger,type AttachmentPutClaim} from '../attachment-object-ledger';
import {createPutSupervisionAuthority} from '../storage/put-supervision-proof';
import type {AttachmentStorage,AttachmentPutSupervision} from '../storage/attachment-storage.port';
const claim={attachmentId:'a',objectId:'o',claimId:'c',attachmentVersion:2,objectVersion:2,leaseOwner:'l',manifest:{locator:{attachmentId:'a',objectId:'o',attemptId:'t',kind:'source'},sizeBytes:1,sha256:'h'}} as AttachmentPutClaim;
function fixture(){
 const authorities=new Map<AttachmentPutSupervision,ReturnType<typeof createPutSupervisionAuthority>>();
 const storage={putTemporary:jest.fn(async()=>{throw Error('legacy must never run');}),supervisePut:jest.fn(locator=>{const a=createPutSupervisionAuthority(locator);authorities.set(a.handle,a);return a.handle;}),putSupervised:jest.fn(async(handle,input)=>{const a=authorities.get(handle)!;a.start();a.settle();return {...claim.manifest,version:'"etag"'};})} as unknown as AttachmentStorage;
 const objects={bindSupervision:jest.fn(async(_client,_claim,_handle)=>({...claim,objectVersion:3}))} as unknown as AttachmentObjectLedger;
 return {storage,objects,authorities,session:new AttachmentPutSession(storage,objects)};
}
describe('captured supervised physical writes',()=>{
 it('fails closed with no legacy fallback when supervised storage is missing',async()=>{
  const legacy={putTemporary:jest.fn()} as unknown as AttachmentStorage;
  await expect(new AttachmentPutSession(legacy).bind({} as PoolClient,claim)).rejects.toThrow();expect(legacy.putTemporary).not.toHaveBeenCalled();
 });
 it('dispatches only the original bound handle, with updated claim version and no legacy call',async()=>{
  const f=fixture(),bound=await f.session.bind({} as PoolClient,claim);f.session.committed();
  const replacement=(f.storage as any).supervisePut(claim.manifest.locator);
  await f.session.put(bound,{...claim.manifest,body:Readable.from([Buffer.from('a')])});
  f.session.acknowledged(bound);
  expect(bound.objectVersion).toBe(3);expect(f.storage.putTemporary).not.toHaveBeenCalled();expect((f.storage as any).putSupervised).toHaveBeenCalledWith([...f.authorities.keys()][0],expect.anything());
  expect(await f.session.retireUnused(async()=>{})).toEqual([]);f.session.releaseResolved();expect([...f.authorities.values()][0].released).toBe(true);
  expect(f.authorities.get(replacement)!.state).toBe('ISSUED');replacement.release();
 });
 it('requires actual local closure and original ISSUED entry before producing terminal retirement proofs',async()=>{
  const f=fixture();await f.session.bind({} as PoolClient,claim);f.session.committed();let stopped=false;
  const proofs=await f.session.retireUnused(async()=>{stopped=true;});expect(stopped).toBe(true);expect(proofs).toHaveLength(1);expect([...f.authorities.values()][0].state).toBe('RETIRED');
  await expect(f.session.put(proofs[0].claim,{...claim.manifest,body:Readable.from([Buffer.from('a')])})).rejects.toThrow('ATTACHMENT_STORAGE_CONFLICT');
 });
 it('never certifies a started unknown send and retains its handle',async()=>{
  const f=fixture(),bound=await f.session.bind({} as PoolClient,claim);f.session.committed();[...f.authorities.values()][0].start();
  expect(await f.session.retireUnused(async()=>{})).toEqual([]);f.session.releaseResolved();expect([...f.authorities.values()][0].released).toBe(false);
 });
 it('retains a completed SDK send until the positive result is durably acknowledged',async()=>{
  const f=fixture(),bound=await f.session.bind({} as PoolClient,claim);f.session.committed();await f.session.put(bound,{...claim.manifest,body:Readable.from([Buffer.from('a')])});
  expect(f.session.hasUnresolved).toBe(true);expect(await f.session.retireUnused(async()=>{})).toEqual([]);f.session.releaseResolved();expect([...f.authorities.values()][0].released).toBe(false);
  const handoff=jest.fn();f.session.handoffUnresolved(handoff);expect(handoff).toHaveBeenCalledWith(bound,[...f.authorities.keys()][0]);
 });
 it('releases rolled-back handles without certifying a durable claim',async()=>{
  const f=fixture();await f.session.bind({} as PoolClient,claim);expect(await f.session.retireUnused(async()=>{})).toEqual([]);f.session.releaseResolved();expect([...f.authorities.values()][0].released).toBe(true);
 });
});
