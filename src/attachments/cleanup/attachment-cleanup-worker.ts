import {ATTACHMENT_LIMITS as L} from '../attachment-policy';
import {AttachmentCleanupError,type AttachmentCleanupClaim,type AttachmentCleanupIdentity,type AttachmentCleanupFailure} from '../attachment-cleanup-ledger';
import {AttachmentStorageError,type AttachmentStorage} from '../storage/attachment-storage.port';
/** Internal durable transaction boundary. Implementations must re-enter ordered
 * system domain/account -> attachment -> object -> job locks for every method,
 * commit before provider I/O, and never settle uncertain PUTs from absence. */
export interface AttachmentCleanupRepository {
 maintainMetadata(limit:number):Promise<number>;
 due(limit:number):Promise<AttachmentCleanupIdentity[]>;
 claim(identity:AttachmentCleanupIdentity):Promise<AttachmentCleanupClaim>;
 finish(claim:AttachmentCleanupClaim):Promise<void>;
 fail(claim:AttachmentCleanupClaim,code:AttachmentCleanupFailure):Promise<void>;
}
export interface AttachmentCleanupAlert {code:'CLEANUP_UNAVAILABLE'|'CLEANUP_DEBT_RETAINED';jobId?:string}
/** Awake-only scheduler. No erasure SLA while the Free TEST host sleeps.
 * It never releases reservations itself or deletes unknown provider objects.
 * Repository.finish must record a DB-clock receipt only after this worker's
 * fresh exact HEAD/list checks and recheck the durable cleanup lease/version. */
export class AttachmentCleanupWorker {
 private active:Promise<void>|null=null;
 private timer:NodeJS.Timeout|null=null;
 private closed=false;
 constructor(private readonly repository:AttachmentCleanupRepository,private readonly storage:AttachmentStorage,private readonly alert:(event:AttachmentCleanupAlert)=>void=()=>undefined){}
 start():void {
  if(this.closed||this.timer)return;
  this.kick();this.timer=setInterval(()=>this.kick(),L.cleanupIntervalMs);this.timer.unref();
 }
 kick():void {void this.run().catch(()=>this.notify({code:'CLEANUP_UNAVAILABLE'}));}
 private notify(event:AttachmentCleanupAlert):void {try{this.alert(event);}catch{/* Alerting failure cannot erase durable cleanup debt. */}}
 async stop():Promise<void>{this.closed=true;if(this.timer){clearInterval(this.timer);this.timer=null;}await this.active;}
 run():Promise<void>{
  if(this.closed||this.active)return Promise.resolve();
  const work=this.tick();this.active=work;
  void work.finally(()=>{if(this.active===work)this.active=null;}).catch(()=>undefined);
  return work;
 }
 private async tick():Promise<void>{
  const expired=await this.repository.maintainMetadata(L.cleanupBatch);if(this.closed)return;
  if(!Number.isInteger(expired)||expired<0||expired>L.cleanupBatch)throw Error('ATTACHMENT_CLEANUP_BATCH_INVALID');
  const remaining=L.cleanupBatch-expired;if(!remaining)return;
  const due=await this.repository.due(remaining);
  if(!Array.isArray(due)||due.length>remaining)throw Error('ATTACHMENT_CLEANUP_BATCH_INVALID');
  for(const id of due){
   if(this.closed)break;let claim:AttachmentCleanupClaim;
   try{claim=await this.repository.claim(id);}catch(error){if(error instanceof AttachmentCleanupError&&error.code==='CLAIM_CONFLICT')continue;this.notify({code:'CLEANUP_UNAVAILABLE',jobId:id.jobId});continue;}
   try{
    if(claim.expected)await this.storage.deleteOwned(claim.expected);
    else if(await this.storage.head(claim.manifest.locator))throw new AttachmentStorageError('OWNERSHIP');
    await this.storage.confirmAbsent(claim.manifest.locator);
    // Only this private control path can invoke completion after the probes.
    await this.repository.finish(claim);
   }catch(error){
    const code:AttachmentCleanupFailure=error instanceof AttachmentStorageError?(error.code==='OWNERSHIP'?'STORAGE_OWNERSHIP':error.code==='INTEGRITY'?'STORAGE_INTEGRITY':'STORAGE_UNAVAILABLE'):'STORAGE_UNAVAILABLE';
    try{await this.repository.fail(claim,code);}catch{/* Expired/stolen claims retain their existing durable debt. */}
    this.notify({code:'CLEANUP_DEBT_RETAINED',jobId:claim.jobId});
   }
  }
 }
}
