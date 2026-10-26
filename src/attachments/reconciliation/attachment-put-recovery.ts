import {createHash} from 'node:crypto';import {Readable} from 'node:stream';import {finished} from 'node:stream/promises';
import type {Pool,PoolClient} from 'pg';import {transaction} from '../../study-groups/study-group.store';
import {ATTACHMENT_LIMITS as L} from '../attachment-policy';import type {AttachmentPutClaim} from '../attachment-object-ledger';
import {originalPutSettlement} from '../storage/put-supervision-proof';
import type {AttachmentPutSupervision} from '../storage/attachment-storage.port';
import type {AttachmentStorage,AttachmentStoredObject,AttachmentObjectLocator} from '../storage/attachment-storage.port';
import {AttachmentLifecycleLedger} from '../lifecycle/attachment-lifecycle-ledger';
export class AttachmentPutRecoveryError extends Error {constructor(readonly code:'CLAIM_CONFLICT'|'INTEGRITY'|'UNAVAILABLE'){super('ATTACHMENT_PUT_RECOVERY_'+code);this.name='AttachmentPutRecoveryError';}}
const fail=(code:AttachmentPutRecoveryError['code']):never=>{throw new AttachmentPutRecoveryError(code);};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function validate(claim:AttachmentPutClaim):void{
 const p=claim?.manifest?.locator;
 if(claim?.supervisionId!==undefined&&(typeof claim.supervisionId!=='string'||!UUID.test(claim.supervisionId)))fail('CLAIM_CONFLICT');
 if(!p||![claim.attachmentId,claim.objectId,claim.claimId,claim.leaseOwner,p.attachmentId,p.objectId,p.attemptId].every(v=>typeof v==='string'&&UUID.test(v))||p.attachmentId!==claim.attachmentId||p.objectId!==claim.objectId||!['source','normalized','thumbnail'].includes(p.kind)||!Number.isSafeInteger(claim.attachmentVersion)||claim.attachmentVersion<0||!Number.isSafeInteger(claim.objectVersion)||claim.objectVersion<1||!Number.isSafeInteger(claim.manifest.sizeBytes)||claim.manifest.sizeBytes<1||claim.manifest.sizeBytes>(p.kind==='thumbnail'?L.thumbnailBytes:L.imageBytes)||!/^[a-f0-9]{64}$/.test(claim.manifest.sha256))fail('CLAIM_CONFLICT');
}
function locator(a:AttachmentObjectLocator,b:AttachmentObjectLocator):boolean{return !!b&&a.attachmentId===b.attachmentId&&a.attemptId===b.attemptId&&a.objectId===b.objectId&&a.kind===b.kind;}
function sameClaim(a:AttachmentPutClaim,b:AttachmentPutClaim):boolean{return a.attachmentId===b.attachmentId&&a.objectId===b.objectId&&a.claimId===b.claimId&&a.leaseOwner===b.leaseOwner&&a.attachmentVersion===b.attachmentVersion&&a.objectVersion===b.objectVersion&&a.supervisionId===b.supervisionId&&locator(a.manifest.locator,b.manifest.locator)&&a.manifest.sha256===b.manifest.sha256&&a.manifest.sizeBytes===b.manifest.sizeBytes;}
function receipt(a:AttachmentStoredObject,b:AttachmentStoredObject):boolean{return !!b&&locator(a.locator,b.locator)&&a.sha256===b.sha256&&a.sizeBytes===b.sizeBytes&&a.version===b.version;}
export type RecoveredProducer='upload'|'processing';
export interface AttachmentPutRecoveryRepository {
 verifyTerminalClaim(claim:AttachmentPutClaim):Promise<boolean>;
 acknowledge(claim:AttachmentPutClaim,observed:AttachmentStoredObject):Promise<void>;
 settleProducer(claim:AttachmentPutClaim,producer:RecoveredProducer):Promise<void>;
}
declare const stoppedBrand:unique symbol;
export interface PutRecoveryQuiescence {readonly [stoppedBrand]:true;}
interface Supervisor {claim:AttachmentPutClaim;producer:RecoveredProducer;wait:()=>Promise<void>;completion?:Promise<void>;}
const supervisors=new WeakMap<PutRecoveryQuiescence,Supervisor>();
/** Legacy unbound-claim infrastructure proof, never an HTTP DTO. Bound/enabled
 * claims must use the opaque original-adapter factory below; stripping their id
 * also fails the durable repository check. The callback must await actual
 * local SDK transport.send settlement AND owned file/child closure for this exact
 * producer. Public PUT rejection, abort request, lease expiry, HEAD and process
 * restart are not such evidence.
 */
export function createPutRecoveryQuiescence(claim:AttachmentPutClaim,producer:RecoveredProducer,waitForActualProducerStopped:()=>Promise<void>):PutRecoveryQuiescence{
 validate(claim);if(claim.supervisionId!==undefined)return fail('CLAIM_CONFLICT');if(!['upload','processing'].includes(producer)||typeof waitForActualProducerStopped!=='function'||(producer==='upload')!==(claim.manifest.locator.kind==='source'))return fail('CLAIM_CONFLICT');
 const cap=Object.freeze({}) as PutRecoveryQuiescence;supervisors.set(cap,{claim:structuredClone(claim),producer,wait:waitForActualProducerStopped});return cap;
}
/** Enabled supervised recovery cannot substitute an arbitrary wait callback. */
export function createSupervisedPutRecoveryQuiescence(claim:AttachmentPutClaim,handle:AttachmentPutSupervision):{capability:PutRecoveryQuiescence;actual:Promise<void>}{
 validate(claim);if(!claim.supervisionId)return fail('CLAIM_CONFLICT');
 const original=originalPutSettlement(handle,claim.manifest.locator);if(original.id!==claim.supervisionId)return fail('CLAIM_CONFLICT');
 const capability=Object.freeze({}) as PutRecoveryQuiescence;
 supervisors.set(capability,{claim:structuredClone(claim),producer:claim.manifest.locator.kind==='source'?'upload':'processing',wait:()=>original.actual});
 return {capability,actual:original.actual};
}
async function deadline<T>(operation:Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted)return fail('UNAVAILABLE');let abort!:()=>void;
 const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(new AttachmentPutRecoveryError('UNAVAILABLE'));signal.addEventListener('abort',abort,{once:true});});
 try{return await Promise.race([operation,cancelled]);}finally{signal.removeEventListener('abort',abort);}
}
/** One explicit immutable consumed claim, not an enumerator or a user-facing API.
 * Positive HEAD plus full digest-verified read records late commit only. Missing
 * objects remain UNKNOWN. This never deletes, recreates keys or promotes READY.
 * Lease/slot release requires the separate sealed actual-supervisor capability.
 */
export class AttachmentPutRecovery {
 private readonly active=new Set<string>();
 constructor(private readonly repository:AttachmentPutRecoveryRepository,private readonly storage:Pick<AttachmentStorage,'head'|'openRead'>){}
 async recover(input:AttachmentPutClaim,capability?:PutRecoveryQuiescence):Promise<{status:'UNKNOWN'|'RECORDED_AWAITING_QUIESCENCE'|'RECORDED_AND_SETTLED'}>{
  validate(input);const claim=structuredClone(input);let supervisor:Supervisor|undefined;
  if(capability!==undefined){supervisor=supervisors.get(capability);if(!supervisor||!sameClaim(supervisor.claim,claim))return fail('CLAIM_CONFLICT');}
  if(this.active.has(claim.objectId))return fail('UNAVAILABLE');this.active.add(claim.objectId);
  try{
   if(!await this.repository.verifyTerminalClaim(claim))return fail('CLAIM_CONFLICT');
   const observed=await this.readPositive(claim);if(!observed)return {status:'UNKNOWN'};
   await this.repository.acknowledge(claim,observed);
   if(!supervisor)return {status:'RECORDED_AWAITING_QUIESCENCE'};
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),L.storageCallMs);
   try{supervisor.completion??=Promise.resolve().then(()=>supervisor!.wait());await deadline(supervisor.completion,controller.signal);}finally{clearTimeout(timer);}
   await this.repository.settleProducer(claim,supervisor.producer);
   return {status:'RECORDED_AND_SETTLED'};
  }catch(error){if(error instanceof AttachmentPutRecoveryError)throw error;return fail('UNAVAILABLE');}
  finally{this.active.delete(claim.objectId);}
 }
 private async readPositive(claim:AttachmentPutClaim):Promise<AttachmentStoredObject|null>{
  const controller=new AbortController();let body:Readable|undefined,idle:NodeJS.Timeout|undefined;
  const abort=()=>{controller.abort();body?.destroy(new AttachmentPutRecoveryError('UNAVAILABLE'));};
  const total=setTimeout(abort,L.streamTotalMs),headTimeout=setTimeout(abort,L.storageCallMs);
  try{
   const head=await deadline(this.storage.head(claim.manifest.locator),controller.signal);clearTimeout(headTimeout);
   if(head===null)return null;
   if(!head||!locator(claim.manifest.locator,head.locator)||head.sha256!==claim.manifest.sha256||head.sizeBytes!==claim.manifest.sizeBytes||!/^"[\x21\x23-\x7e]{1,254}"$/.test(head.version))return fail('INTEGRITY');
   const open=this.storage.openRead(head,undefined,controller.signal).then(result=>{if(controller.signal.aborted){if(result.body instanceof Readable){result.body.on('error',()=>undefined);result.body.destroy();}return fail('UNAVAILABLE');}return result;});
   idle=setTimeout(abort,L.streamIdleMs);
   const read=await deadline(open,controller.signal);body=read.body;if(!(body instanceof Readable))return fail('INTEGRITY');body.on('error',ignore);
   if(!receipt(head,read)||read.responseBytes!==head.sizeBytes)return fail('INTEGRITY');
   let count=0;const hash=createHash('sha256');
   for await(const chunk of body){if(controller.signal.aborted)return fail('UNAVAILABLE');if(!Buffer.isBuffer(chunk)||count+chunk.length>head.sizeBytes)return fail('INTEGRITY');count+=chunk.length;hash.update(chunk);if(chunk.length){if(idle)clearTimeout(idle);idle=setTimeout(abort,L.streamIdleMs);}}
   if(controller.signal.aborted)return fail('UNAVAILABLE');if(count!==head.sizeBytes||hash.digest('hex')!==head.sha256)return fail('INTEGRITY');
   return {...head,locator:{...head.locator}};
  }finally{
   clearTimeout(total);clearTimeout(headTimeout);if(idle)clearTimeout(idle);
   if(body){const closed=finished(body,{cleanup:true}).catch(()=>undefined);body.destroy();await closed;body.removeListener('error',ignore);}
  }
 }
}
function ignore():void{}
/** Concrete infrastructure repository: all writes re-enter existing system domain
 * locks through Lifecycle. Terminal state is rechecked in the same transaction;
 * an intervening nonterminal observation cannot acknowledge or release authority.
 */
export class PostgresAttachmentPutRecoveryRepository implements AttachmentPutRecoveryRepository {
 constructor(private readonly pool:Pool,private readonly lifecycle=new AttachmentLifecycleLedger()){}
 private async matchesTerminal(queryable:Pick<Pool,'query'>|Pick<PoolClient,'query'>,claim:AttachmentPutClaim,lock=false):Promise<boolean>{
  const row=(await queryable.query<{state:string;put_claim:string|null;variant:string;attempt_id:string;byte_count:string;sha256:string;put_supervision_id:string|null;put_abandoned_at:Date|null}>(`SELECT a.state,o.put_claim,o.variant,o.attempt_id,o.byte_count,o.sha256,o.put_supervision_id,o.put_abandoned_at FROM attachments a JOIN attachment_objects o ON o.attachment_id=a.id WHERE a.id=$1 AND o.id=$2${lock?' FOR UPDATE OF o':''}`,[claim.attachmentId,claim.objectId])).rows[0];
  return !!row&&['DELETED','REJECTED'].includes(row.state)&&!row.put_abandoned_at&&row.put_claim===claim.claimId&&row.variant===claim.manifest.locator.kind&&row.attempt_id===claim.manifest.locator.attemptId&&Number(row.byte_count)===claim.manifest.sizeBytes&&row.sha256===claim.manifest.sha256&&(row.put_supervision_id??undefined)===claim.supervisionId;
 }
 async verifyTerminalClaim(claim:AttachmentPutClaim):Promise<boolean>{validate(claim);return this.matchesTerminal(this.pool,claim);}
 private async lockExactTerminal(client:PoolClient,claim:AttachmentPutClaim):Promise<void>{
  // Same immutable original identity is checked under account/domain -> attachment
  // -> object locks before positive acknowledgment OR any quota/lease release.
  await this.lifecycle.lockForTerminalRetention(client,claim.attachmentId);
  if(!await this.matchesTerminal(client,claim,true))return fail('CLAIM_CONFLICT');
 }
 async acknowledge(claim:AttachmentPutClaim,observed:AttachmentStoredObject):Promise<void>{
  validate(claim);await transaction(this.pool,async client=>{await this.lockExactTerminal(client,claim);await this.lifecycle.recordPutResult(client,claim,observed);});
 }
 async settleProducer(claim:AttachmentPutClaim,producer:RecoveredProducer):Promise<void>{
  validate(claim);if(!['upload','processing'].includes(producer))return fail('CLAIM_CONFLICT');await transaction(this.pool,async client=>{await this.lockExactTerminal(client,claim);if(producer==='upload')await this.lifecycle.settleUpload(client,{attachmentId:claim.attachmentId,leaseOwner:claim.leaseOwner,producerQuiesced:true});else await this.lifecycle.settleProcessing(client,claim.attachmentId,claim.leaseOwner,{producerQuiesced:true});});
 }
}
