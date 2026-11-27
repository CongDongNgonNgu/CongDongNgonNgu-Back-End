import type {PlannedPutSupervisionIdentity} from '../storage/put-supervision-proof';
import type {PoolClient} from 'pg';
import {AttachmentObjectLedger,type AttachmentPutClaim} from '../attachment-object-ledger';
import {AttachmentStorageError,type AttachmentStorage,type SupervisableAttachmentStorage,type AttachmentPutSupervision} from '../storage/attachment-storage.port';
import {supervisionIdentity,createPutLocalClosure,type PutLocalClosure,type PutUnsentCertificate} from '../storage/put-supervision-proof';
interface Entry {claim:AttachmentPutClaim;handle:AttachmentPutSupervision;committed:boolean;commitAttempted:boolean;dispatched:boolean;positive:boolean;abandoned:boolean;retirement?:PutRetirement;}
const sameClaim=(a:AttachmentPutClaim,b:AttachmentPutClaim)=>a.attachmentId===b.attachmentId&&a.objectId===b.objectId&&a.claimId===b.claimId&&a.attachmentVersion===b.attachmentVersion&&a.leaseOwner===b.leaseOwner&&a.objectVersion===b.objectVersion&&a.supervisionId===b.supervisionId&&a.manifest.sizeBytes===b.manifest.sizeBytes&&a.manifest.sha256===b.manifest.sha256&&Object.entries(a.manifest.locator).every(([key,value])=>b.manifest.locator[key as keyof typeof b.manifest.locator]===value);
export interface PutRetirement {claim:AttachmentPutClaim;certificate:PutUnsentCertificate;closure:PutLocalClosure;}
/** Request-local captured handles. No lookup/replacement by locator is allowed.
 * The service commits every binding before dispatch and terminalizes the entity
 * before persisting returned retirement proofs. Unknown started sends stay held. */
export class AttachmentPutSession {
 private readonly entries=new Map<string,Entry>();
 constructor(private readonly storage:AttachmentStorage,private readonly objects=new AttachmentObjectLedger()){}
 private supervised():SupervisableAttachmentStorage {
  const storage=this.storage as SupervisableAttachmentStorage;
  if(typeof storage.supervisePut!=='function'||typeof storage.putSupervised!=='function')throw new AttachmentStorageError('UNAVAILABLE');
  return storage;
 }
 async bind(client:PoolClient,claim:AttachmentPutClaim,plannedSupervisionId?:PlannedPutSupervisionIdentity):Promise<AttachmentPutClaim>{
  if(this.entries.has(claim.objectId))throw new AttachmentStorageError('CONFLICT');
  const handle=this.supervised().supervisePut(claim.manifest.locator,plannedSupervisionId);
  try{if(plannedSupervisionId!==undefined&&handle.id!==plannedSupervisionId.id)throw new AttachmentStorageError('CONFLICT');const bound=await this.objects.bindSupervision(client,claim,handle);this.entries.set(bound.objectId,{claim:bound,handle,committed:false,commitAttempted:false,dispatched:false,positive:false,abandoned:false});return bound;}
  catch(error){handle.release();throw error;}
 }
 /** Call immediately before issuing actual COMMIT; unknown acknowledgement retains the original authority. */
 markCommitAttempt():void {for(const entry of this.entries.values()){if(supervisionIdentity(entry.handle,entry.claim.manifest.locator)!==entry.claim.supervisionId)throw new AttachmentStorageError('CONFLICT');entry.commitAttempted=true;}}
 originalHandle(claim:AttachmentPutClaim):AttachmentPutSupervision{const e=this.entries.get(claim.objectId);if(!e||!sameClaim(e.claim,claim))throw new AttachmentStorageError('CONFLICT');return e.handle;}
 cleanupAcknowledged(claim:AttachmentPutClaim):void{const e=this.entries.get(claim.objectId);if(!e||!sameClaim(e.claim,claim))throw new AttachmentStorageError('CONFLICT');e.abandoned=true;}
 committed():void {for(const entry of this.entries.values()){entry.committed=true;entry.commitAttempted=true;}}
 async put(claim:AttachmentPutClaim,input:Parameters<AttachmentStorage['putTemporary']>[0]){
  const entry=this.entries.get(claim.objectId);
  if(!entry?.committed||!sameClaim(entry.claim,claim)||entry.dispatched||entry.retirement)throw new AttachmentStorageError('CONFLICT');
  entry.dispatched=true;return this.supervised().putSupervised(entry.handle,input);
 }
 /** Only after recordPutResult's transaction commits. A positive SDK response
  * with failed/ambiguous DB acknowledgement still needs supervised recovery. */
 acknowledged(claim:AttachmentPutClaim):void{const entry=this.entries.get(claim.objectId);if(!entry?.dispatched||!sameClaim(entry.claim,claim))throw new AttachmentStorageError('CONFLICT');entry.positive=true;}
 /** Called only after the service's actual spooling/native/continuation work has
  * closed. A failed closure callback or STARTED entry cannot produce a proof. */
 async retireUnused(waitForActualLocalClosure:()=>Promise<void>):Promise<PutRetirement[]>{
  const proofs:PutRetirement[]=[];
  for(const entry of this.entries.values()){
   if(!entry.committed||entry.positive||entry.abandoned)continue;
   if(!entry.retirement){
    const closure=await createPutLocalClosure(entry.claim,entry.handle,waitForActualLocalClosure);
    let certificate:PutUnsentCertificate;
    try{certificate=entry.handle.retireUnsent();}catch(error){if(error instanceof AttachmentStorageError&&error.code==='CONFLICT')continue;throw error;}
    entry.retirement={claim:entry.claim,certificate,closure};
   }
   proofs.push(entry.retirement);
  }
  return proofs;
 }
 abandoned(claim:AttachmentPutClaim):void {const entry=this.entries.get(claim.objectId);if(!entry?.retirement||entry.claim!==claim)throw new AttachmentStorageError('CONFLICT');entry.abandoned=true;}
 get hasUnresolved():boolean{return [...this.entries.values()].some(e=>e.commitAttempted&&!e.positive&&!e.abandoned);}
 /** Trusted callback attests that the service's local producers are already
  * closed. It must only enqueue observation; no provider wait or public input. */
 handoffUnresolved(receive:(claim:AttachmentPutClaim,handle:AttachmentPutSupervision)=>void):void{
  for(const entry of this.entries.values())if(entry.committed&&!entry.positive&&!entry.abandoned)receive(entry.claim,entry.handle);
 }
 releaseResolved():void{for(const entry of this.entries.values())if(!entry.commitAttempted||entry.positive||entry.abandoned)entry.handle.release();}
}
