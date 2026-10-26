import {ATTACHMENT_LIMITS as L} from '../attachment-policy';
import type {AttachmentPutClaim} from '../attachment-object-ledger';
import {AttachmentStorageError,type AttachmentPutSupervision} from '../storage/attachment-storage.port';
import {createSupervisedPutRecoveryQuiescence,type AttachmentPutRecovery,type PutRecoveryQuiescence} from './attachment-put-recovery';
interface Entry {claim:AttachmentPutClaim;handle:AttachmentPutSupervision;capability:PutRecoveryQuiescence;actualSettled:boolean;attempts:number;next:number;}
export interface PutRecoveryAlert {code:'PUT_RECOVERY_DEBT_RETAINED';count:number;}
/** Internal post-terminal handoff only. The caller has already awaited ALL local
 * body/file/native/moderation continuations. This queue additionally waits for the
 * original actual SDK send; a foreground rejection or an elapsed lease never
 * makes an entry eligible. It never creates replacement handles or resets leases
 * on boot. Restart loses local authority and leaves durable debt for inspection.
 */
export class AttachmentPutRecoveryQueue {
 private readonly entries=new Map<string,Entry>();
 private active:Promise<void>|null=null;private timer?:NodeJS.Timeout;private stopped=false;
 constructor(private readonly recovery:Pick<AttachmentPutRecovery,'recover'>,private readonly alert:(event:PutRecoveryAlert)=>void=()=>undefined,private readonly now:()=>number=Date.now){}
 enqueue(input:AttachmentPutClaim,handle:AttachmentPutSupervision):void {
  if(this.stopped)throw new AttachmentStorageError('UNAVAILABLE');
  const existing=this.entries.get(input.objectId);
  if(existing){if(existing.handle!==handle||JSON.stringify(existing.claim)!==JSON.stringify(input))throw new AttachmentStorageError('CONFLICT');return;}
  if(this.entries.size>=L.deploymentMetadata*3)throw new AttachmentStorageError('UNAVAILABLE');
  const claim=structuredClone(input);
  const {capability,actual}=createSupervisedPutRecoveryQuiescence(claim,handle);
  const entry:Entry={claim,handle,capability,actualSettled:false,attempts:0,next:this.now()};
  this.entries.set(claim.objectId,entry);
  void actual.then(()=>{entry.actualSettled=true;},()=>this.notify());
 }
 start():void {if(this.stopped||this.timer)return;this.timer=setInterval(()=>{void this.run().catch(()=>this.notify());},L.cleanupIntervalMs);this.timer.unref();}
 run():Promise<void>{if(this.stopped)return Promise.resolve();if(this.active)return this.active;const task=this.tick();this.active=task;void task.finally(()=>{if(this.active===task)this.active=null;}).catch(()=>undefined);return task;}
 private async tick():Promise<void>{
  let admitted=0;
  for(const [id,entry] of this.entries){
   if(this.stopped||admitted>=L.cleanupBatch)break;
   if(!entry.actualSettled||entry.attempts>=L.cleanupAttempts||entry.next>this.now())continue;
   admitted++;entry.attempts++;
   try{
    const result=await this.recovery.recover(entry.claim,entry.capability);
    if(result.status==='RECORDED_AND_SETTLED'){this.entries.delete(id);entry.handle.release();continue;}
   }catch{/* Keep exact durable ownership; error details may contain private URLs. */}
   entry.next=this.now()+Math.min(L.cleanupMaxBackoffMs,L.cleanupIntervalMs*2**(entry.attempts-1));
   if(entry.attempts===L.cleanupAttempts)this.notify();
  }
 }
 private notify():void{try{this.alert({code:'PUT_RECOVERY_DEBT_RETAINED',count:this.entries.size});}catch{/* Alerting never grants cleanup authority. */}}
 async stop():Promise<void>{this.stopped=true;if(this.timer)clearInterval(this.timer);await this.active;if(this.entries.size)this.notify();}
}
