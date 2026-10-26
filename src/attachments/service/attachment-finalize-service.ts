import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {finished} from 'node:stream/promises';
import type {Pool} from 'pg';
import {transaction} from '../../study-groups/study-group.store';
import {ATTACHMENT_LIMITS as L,type AttachmentFormat,type parseAttachmentCapabilities} from '../attachment-policy';
import {AttachmentQuotaLedger} from '../attachment-quota-ledger';
import {AttachmentFinalizationLedger,AttachmentFinalizationError} from '../finalization/attachment-finalization-ledger';
import {createProcessorProof,inspectProcessorResult,processorProofArtifacts,type ProcessorArtifact} from '../finalization/processor-proof';
import {AttachmentLifecycleLedger,AttachmentLifecycleError} from '../lifecycle/attachment-lifecycle-ledger';
import {lockAuthorizedDraft,readDraftStatus,projectDraft,type AttachmentDraftStatus} from '../initiation/attachment-draft-repository';
import {AttachmentInitiationUnavailable} from '../initiation/attachment-initiation-repository';
import {AttachmentStorageError,type AttachmentStorage,type AttachmentStoredObject,type AttachmentPutSupervision} from '../storage/attachment-storage.port';
import type {AttachmentPutClaim} from '../attachment-object-ledger';
import {AttachmentValidationError} from '../validation/validation-error';
import {ImageProcessingError,type ImageProcessor} from '../processing/image-processor';
import {VideoProcessingError,type NativeVideoProcessor} from '../video-processing/video-processor';
import {AttachmentPutSession} from './attachment-put-session';
export interface AttachmentModerationPolicy {
 /** Trusted internal post-validation policy, never an HTTP callback or antivirus claim. */
 review(input:{attachmentId:string;format:AttachmentFormat;artifacts:readonly ProcessorArtifact[]},signal?:AbortSignal):Promise<'ALLOW'|'REJECT'|'QUARANTINE'>;
}
export const localValidatedMediaPolicy:AttachmentModerationPolicy={review:async()=> 'ALLOW'};
interface Options {imageProcessor?:Pick<ImageProcessor,'process'>;videoProcessor?:Pick<NativeVideoProcessor,'process'>;moderation?:AttachmentModerationPolicy;moderationTimeoutMs?:number;/** Trusted internal local-closure attestation; synchronously enqueue only. */onUncertainPut?:(claim:AttachmentPutClaim,handle:AttachmentPutSupervision)=>void;}
interface Request {actorId:string;attachmentId:string;reauthorize:()=>Promise<void>;signal?:AbortSignal;}
const exact=(a:AttachmentStoredObject,b:AttachmentStoredObject)=>a.sizeBytes===b.sizeBytes&&a.sha256===b.sha256&&a.version===b.version&&Object.entries(a.locator).every(([k,v])=>b.locator[k as keyof typeof a.locator]===v);
/** Shared internal orchestration. All I/O/native work runs outside SQL locks;
 * immutable manifests precede PUTs, completed receipts are acknowledged even
 * after revocation, and publication rechecks current session/domain/fence.
 * Unknown provider outcomes or an unsettled moderation callback retain producer
 * ownership. Neither rejected promises, elapsed leases nor cancellation requests
 * prove quiescence. No routes or format activation occur in this class. */
export class AttachmentFinalizeService {
 private readonly unresolvedWrites=new Set<AttachmentPutSession>();
 private readonly ledger=new AttachmentFinalizationLedger();
 private readonly lifecycle=new AttachmentLifecycleLedger();
 private readonly quotas=new AttachmentQuotaLedger();
 private readonly moderation:AttachmentModerationPolicy;
 private readonly moderationMs:number;
 constructor(private readonly pool:Pool,private readonly storage:AttachmentStorage,private readonly capabilities:ReturnType<typeof parseAttachmentCapabilities>,private readonly options:Options={}){
  this.moderation=options.moderation??localValidatedMediaPolicy;this.moderationMs=options.moderationTimeoutMs??L.storageCallMs;
  if(!Number.isInteger(this.moderationMs)||this.moderationMs<1||this.moderationMs>L.storageCallMs)throw new AttachmentInitiationUnavailable();
 }
 private live(signal?:AbortSignal):void{if(signal?.aborted)throw new ImageProcessingError('PROCESSING_CANCELLED');}
 private async source(expected:AttachmentStoredObject,signal?:AbortSignal):Promise<Buffer>{
  this.live(signal);const response=await this.storage.openRead(expected,undefined,signal);
  try{
   if(!exact(expected,response)||response.responseBytes!==expected.sizeBytes)throw new AttachmentStorageError('INTEGRITY');
   const chunks:Buffer[]=[];let size=0;const hash=createHash('sha256');
   for await(const value of response.body){this.live(signal);if(!Buffer.isBuffer(value))throw new AttachmentStorageError('INTEGRITY');size+=value.length;if(size>expected.sizeBytes)throw new AttachmentStorageError('INTEGRITY');hash.update(value);chunks.push(value);}
   this.live(signal);if(size!==expected.sizeBytes||hash.digest('hex')!==expected.sha256)throw new AttachmentStorageError('INTEGRITY');return Buffer.concat(chunks,size);
  }finally{const closed=finished(response.body,{cleanup:true}).catch(()=>undefined);response.body.destroy();await closed;}
 }
 private async review(input:Parameters<AttachmentModerationPolicy['review']>[0],signal:AbortSignal|undefined,settled:()=>void):Promise<'ALLOW'|'REJECT'|'QUARANTINE'>{
  this.live(signal);const controller=new AbortController();let timer:NodeJS.Timeout|undefined;
  const task=Promise.resolve().then(()=>this.moderation.review(input,controller.signal)).then(value=>{settled();return value;},()=>{settled();throw new AttachmentInitiationUnavailable();});
  let cancel=()=>{};
  try{return await Promise.race([task,new Promise<never>((_resolve,reject)=>{const stop=()=>{controller.abort();reject(new AttachmentInitiationUnavailable());};cancel=stop;timer=setTimeout(stop,this.moderationMs);signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();})]);}
  finally{if(timer)clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.abort();}
 }
 async finalize(request:Request):Promise<AttachmentDraftStatus>{
  const {actorId:actor,attachmentId:id,signal}=request;await request.reauthorize();this.live(signal);
  if(!this.capabilities.enabled)throw new AttachmentInitiationUnavailable();
  await transaction(this.pool,c=>this.quotas.consumeRead(c,actor));
  const admitted=await transaction(this.pool,async c=>{
   const row=await lockAuthorizedDraft(c,actor,id);if(!this.capabilities[row.format==='IMAGE'?'image':row.format==='VIDEO'?'video':'text'])throw new AttachmentInitiationUnavailable();
   if(row.state==='READY'||row.state==='REJECTED')return {status:projectDraft(row)};
   if(row.state!=='PENDING')throw new AttachmentFinalizationError();
   const declaration=(await c.query<{declared_mime:string;lease_owner:string|null}>('SELECT declared_mime,lease_owner FROM attachments WHERE id=$1',[id])).rows[0];
   if(declaration.lease_owner)return {status:projectDraft(row)};
   const fence=await this.ledger.claimProcessing(c,actor,id);return {fence,format:row.format,declaration:{filename:row.display_filename,mime:declaration.declared_mime}};
  });
  if(admitted.status)return admitted.status;
  const fence=admitted.fence!;let moderationSettled=true;
  const writes=new AttachmentPutSession(this.storage);
  let allowRecoveryHandoff=false;
  let rejection:'INVALID_CONTENT'|'MODERATION_REJECTED'|'MODERATION_PENDING'|'PROCESSING_FAILED'='PROCESSING_FAILED';
  try{
   const bytes=await this.source(fence.source,signal),declaration=admitted.declaration!;let completed:Parameters<typeof createProcessorProof>[2];
   if(admitted.format==='TEXT')completed={format:'TEXT'};
   else if(admitted.format==='IMAGE'){if(!this.options.imageProcessor)throw new ImageProcessingError('PROCESSING_UNAVAILABLE');completed={format:'IMAGE',result:await this.options.imageProcessor.process(bytes,declaration,signal)};}
   else{if(!this.options.videoProcessor)throw new VideoProcessingError('PROCESSING_UNAVAILABLE');completed={format:'VIDEO',result:await this.options.videoProcessor.process(bytes,declaration,signal)};}
   const inspected=inspectProcessorResult(bytes,declaration,completed);
   this.live(signal);moderationSettled=false;const decision=await this.review({attachmentId:id,format:admitted.format!,artifacts:inspected.artifacts},signal,()=>{moderationSettled=true;});
   if(decision!=='ALLOW'){
    rejection=decision==='REJECT'?'MODERATION_REJECTED':'MODERATION_PENDING';
    await transaction(this.pool,c=>this.lifecycle.rejectProcessing(c,id,fence.leaseOwner,rejection));
    await transaction(this.pool,c=>this.lifecycle.settleProcessing(c,id,fence.leaseOwner,{producerQuiesced:true}));
    await request.reauthorize();return transaction(this.pool,c=>readDraftStatus(c,actor,id));
   }
   const proof=createProcessorProof(bytes,declaration,completed,'ALLOW');
   await request.reauthorize();this.live(signal);const plan=await transaction(this.pool,c=>this.ledger.prepareArtifacts(c,actor,fence,proof,claim=>writes.bind(c,claim)));
   writes.committed();
   const artifacts=processorProofArtifacts(proof);
   for(const claim of plan.claims){
    this.live(signal);const artifact=artifacts.find(a=>a.variant===claim.manifest.locator.kind);if(!artifact)throw new AttachmentStorageError('INTEGRITY');
    const body=Readable.from([artifact.bytes]);
    let receipt:AttachmentStoredObject;
    try{receipt=await writes.put(claim,{...claim.manifest,body,signal});}finally{const closed=finished(body,{cleanup:true}).catch(()=>undefined);body.destroy();await closed;}
    await transaction(this.pool,c=>this.lifecycle.recordPutResult(c,claim,receipt));
    writes.acknowledged(claim);
   }
   await request.reauthorize();this.live(signal);
   const heads:AttachmentStoredObject[]=[];for(const locator of [fence.source.locator,...plan.claims.map(c=>c.manifest.locator)]){const head=await this.storage.head(locator);if(!head)throw new AttachmentStorageError('NOT_FOUND');heads.push(head);}
   await request.reauthorize();this.live(signal);await transaction(this.pool,c=>this.ledger.publishReady(c,actor,plan,heads));
   return transaction(this.pool,c=>readDraftStatus(c,actor,id));
  }catch(error){
   const invalid=error instanceof AttachmentValidationError||(error instanceof ImageProcessingError||error instanceof VideoProcessingError)&&error.code==='PROCESSING_INVALID';
   if(invalid)rejection='INVALID_CONTENT';
   let terminalized=false;
   try{await transaction(this.pool,c=>this.lifecycle.rejectProcessing(c,id,fence.leaseOwner,rejection));terminalized=true;}
   catch(bookkeeping){if(!(bookkeeping instanceof AttachmentLifecycleError))throw new AttachmentInitiationUnavailable();terminalized=await transaction(this.pool,c=>this.lifecycle.terminalProducer(c,id,fence.leaseOwner,'processing'));}
   const nativeQuiesced=!(error instanceof VideoProcessingError&&'producerQuiesced' in error&&error.producerQuiesced===false);
   // An unknown PUT has its original supervised handle and recovery path. An
   // unresolved read/HEAD has no such PUT authority: retain the processing fence.
   const readsQuiesced=!(error instanceof AttachmentStorageError&&!error.producerQuiesced&&!writes.hasUnresolved);
   if(nativeQuiesced&&readsQuiesced&&moderationSettled&&terminalized){
    // All native calls and the sequential derivative loop were awaited. No later
    // local continuation can dispatch an unused original handle after this catch.
    for(const proof of await writes.retireUnused(async()=>{})){
     await transaction(this.pool,c=>this.lifecycle.abandonUnsent(c,proof.claim,proof.certificate,proof.closure));writes.abandoned(proof.claim);
    }
    allowRecoveryHandoff=true;
   }
   if(!writes.hasUnresolved&&moderationSettled&&nativeQuiesced&&readsQuiesced){
    try{await transaction(this.pool,c=>this.lifecycle.settleProcessing(c,id,fence.leaseOwner,{producerQuiesced:true}));}
    catch(bookkeeping){if(!(bookkeeping instanceof AttachmentLifecycleError))throw new AttachmentInitiationUnavailable();}
   }
   if(invalid){await request.reauthorize();return transaction(this.pool,c=>readDraftStatus(c,actor,id));}
   throw error;
  }finally{writes.releaseResolved();if(writes.hasUnresolved){this.unresolvedWrites.add(writes);if(allowRecoveryHandoff&&this.options.onUncertainPut)try{writes.handoffUnresolved(this.options.onUncertainPut);this.unresolvedWrites.delete(writes);}catch{/* Keep captured handles and durable fence if queue admission fails. */}}}
 }
}
