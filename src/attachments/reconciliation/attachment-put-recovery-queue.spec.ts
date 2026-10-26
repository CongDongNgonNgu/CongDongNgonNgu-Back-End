import {randomUUID} from 'node:crypto';
import {AttachmentPutRecoveryQueue} from './attachment-put-recovery-queue';
import type {AttachmentPutClaim} from '../attachment-object-ledger';
import type {AttachmentPutSupervision} from '../storage/attachment-storage.port';
import {createPutSupervisionAuthority} from '../storage/put-supervision-proof';
function fixture(){
 const attachmentId=randomUUID(),objectId=randomUUID();
 const claim:AttachmentPutClaim={attachmentId,objectId,claimId:randomUUID(),leaseOwner:randomUUID(),attachmentVersion:1,objectVersion:2,manifest:{locator:{attachmentId,objectId,attemptId:randomUUID(),kind:'source'},sizeBytes:1,sha256:'a'.repeat(64)}};
 const release=jest.fn(),authority=createPutSupervisionAuthority(claim.manifest.locator,release),handle=authority.handle;authority.start();Object.assign(claim,{supervisionId:handle.id});
 const settle=()=>authority.settle();
 const recovery={recover:jest.fn(async(_claim:AttachmentPutClaim,_capability:unknown)=>({status:'RECORDED_AND_SETTLED' as const}))};
 const alerts:unknown[]=[];let now=0;
 const queue=new AttachmentPutRecoveryQueue(recovery,e=>alerts.push(e),()=>now);
 return {claim,handle,release,recovery,queue,settle,alerts,advance:(ms:number)=>{now+=ms;}};
}
describe('bounded original-handle recovery scheduling',()=>{
 it('never probes or releases from foreground rejection before actual send settlement',async()=>{const f=fixture();f.queue.enqueue(f.claim,f.handle);await f.queue.run();expect(f.recovery.recover).not.toHaveBeenCalled();expect(f.release).not.toHaveBeenCalled();await f.queue.stop();});
 it('passes a sealed actual-send capability and releases only after durable recovery succeeds',async()=>{const f=fixture();f.queue.enqueue(f.claim,f.handle);f.settle();await Promise.resolve();await f.queue.run();expect(f.recovery.recover).toHaveBeenCalledWith(f.claim,expect.any(Object));expect(f.release).toHaveBeenCalledTimes(1);await f.queue.run();expect(f.recovery.recover).toHaveBeenCalledTimes(1);await f.queue.stop();});
 it('retains unknown objects with bounded backoff and never treats absence as completion',async()=>{const f=fixture();f.recovery.recover.mockResolvedValue({status:'UNKNOWN'} as never);f.queue.enqueue(f.claim,f.handle);f.settle();await Promise.resolve();await f.queue.run();await f.queue.run();expect(f.recovery.recover).toHaveBeenCalledTimes(1);f.advance(60000);await f.queue.run();expect(f.recovery.recover).toHaveBeenCalledTimes(2);expect(f.release).not.toHaveBeenCalled();await f.queue.stop();});
 it('keeps the original immutable claim and rejects replacement supervision',async()=>{const f=fixture();f.queue.enqueue(f.claim,f.handle);const original=structuredClone(f.claim);f.claim.claimId=randomUUID();f.settle();await Promise.resolve();await f.queue.run();expect(f.recovery.recover.mock.calls[0][0]).toEqual(original);await f.queue.stop();const g=fixture();g.queue.enqueue(g.claim,g.handle);expect(()=>g.queue.enqueue(g.claim,{...g.handle,id:randomUUID()})).toThrow();await g.queue.stop();});
 it('has a finite attempt budget, retains debt and emits only scrubbed facts',async()=>{const f=fixture();f.recovery.recover.mockRejectedValue(Error('SECRET_PRIVATE_URL'));f.queue.enqueue(f.claim,f.handle);f.settle();await Promise.resolve();for(let i=0;i<12;i++){await f.queue.run();f.advance(3600000);}expect(f.recovery.recover).toHaveBeenCalledTimes(10);expect(f.release).not.toHaveBeenCalled();expect(JSON.stringify(f.alerts)).not.toContain('SECRET');expect(f.alerts).toContainEqual({code:'PUT_RECOVERY_DEBT_RETAINED',count:1});await f.queue.stop();});
 it('stops without waiting on an unresolved actual-send promise and rejects new admissions',async()=>{const f=fixture();f.queue.enqueue(f.claim,f.handle);await expect(f.queue.stop()).resolves.toBeUndefined();expect(()=>f.queue.enqueue(f.claim,f.handle)).toThrow();expect(f.release).not.toHaveBeenCalled();});
});

describe('first recovery admission original authority',()=>{
 it('rejects a foreign first handle despite an independently valid and settled send',()=>{const f=fixture(),other=fixture();other.settle();expect(()=>f.queue.enqueue(f.claim,other.handle)).toThrow();});
 it('rejects a structurally copied handle with the same public id and methods',()=>{const f=fixture();expect(()=>f.queue.enqueue(f.claim,{...f.handle})).toThrow();});
 it('rejects a released original and a replacement for the same locator',()=>{const f=fixture();f.handle.release();const replacement=createPutSupervisionAuthority(f.claim.manifest.locator);replacement.start();replacement.settle();expect(()=>f.queue.enqueue(f.claim,f.handle)).toThrow();expect(()=>f.queue.enqueue(f.claim,replacement.handle)).toThrow();});
 it('rejects missing durable supervision identity and never-started original entries',()=>{const f=fixture(),legacy={...f.claim};delete (legacy as any).supervisionId;expect(()=>f.queue.enqueue(legacy,f.handle)).toThrow();const issued=createPutSupervisionAuthority(f.claim.manifest.locator);Object.assign(f.claim,{supervisionId:issued.handle.id});expect(()=>f.queue.enqueue(f.claim,issued.handle)).toThrow();});
});
