import {randomUUID} from 'node:crypto';
import {createPutSupervisionAuthority,verifyUnsentProof,createPutLocalClosure} from './put-supervision-proof';
import type {AttachmentPutClaim} from '../attachment-object-ledger';
const locator={attachmentId:randomUUID(),attemptId:randomUUID(),objectId:randomUUID(),kind:'source' as const};
const claim:AttachmentPutClaim={attachmentId:locator.attachmentId,objectId:locator.objectId,claimId:randomUUID(),attachmentVersion:1,leaseOwner:randomUUID(),objectVersion:1,manifest:{locator,sizeBytes:1,sha256:'a'.repeat(64)}};
describe('sealed original-entry unsent authority',()=>{
 it('requires both exact original retirement and actual local closure',async()=>{
  const a=createPutSupervisionAuthority(locator);const certificate=a.handle.retireUnsent();
  let close!:()=>void;const pending=createPutLocalClosure(claim,a.handle,()=>new Promise<void>(resolve=>{close=resolve;}));
  await Promise.resolve();let complete=false;void pending.then(()=>{complete=true;});expect(complete).toBe(false);close();
  const closure=await pending;expect(verifyUnsentProof(claim,a.handle.id,certificate,closure)).toBe(true);
  expect(verifyUnsentProof(claim,randomUUID(),certificate,closure)).toBe(false);
  expect(verifyUnsentProof({...claim,leaseOwner:randomUUID()},a.handle.id,certificate,closure)).toBe(false);
  expect(verifyUnsentProof(claim,a.handle.id,{} as never,closure)).toBe(false);
  expect(verifyUnsentProof(claim,a.handle.id,certificate,{} as never)).toBe(false);
 });
 it('makes STARTED and RETIRED mutually exclusive',()=>{
  const started=createPutSupervisionAuthority(locator);started.start();expect(()=>started.handle.retireUnsent()).toThrow();started.settle();expect(()=>started.handle.retireUnsent()).toThrow();
  const retired=createPutSupervisionAuthority(locator);retired.handle.retireUnsent();expect(()=>retired.start()).toThrow();
 });
 it('cannot use a replacement entry certificate for the persisted original',async()=>{
  const original=createPutSupervisionAuthority(locator);original.start();original.handle.release();
  const replacement=createPutSupervisionAuthority(locator),cert=replacement.handle.retireUnsent(),closure=await createPutLocalClosure(claim,replacement.handle,async()=>undefined);
  expect(verifyUnsentProof(claim,original.handle.id,cert,closure)).toBe(false);
 });
 it('invalidates released handles and rejects failed local closure',async()=>{
  const a=createPutSupervisionAuthority(locator);a.handle.release();expect(()=>a.start()).toThrow();expect(()=>a.handle.retireUnsent()).toThrow();
  const b=createPutSupervisionAuthority(locator);await expect(createPutLocalClosure(claim,b.handle,async()=>{throw Error('not closed');})).rejects.toThrow('not closed');
 });
 it('captures immutable claim and locator identity',async()=>{
  const a=createPutSupervisionAuthority(locator),copied=structuredClone(claim);const closure=await createPutLocalClosure(copied,a.handle,async()=>undefined);copied.claimId=randomUUID();const cert=a.handle.retireUnsent();expect(verifyUnsentProof(claim,a.handle.id,cert,closure)).toBe(true);expect(verifyUnsentProof(copied,a.handle.id,cert,closure)).toBe(false);
 });
});
