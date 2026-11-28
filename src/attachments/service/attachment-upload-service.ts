import {originalPutState} from '../storage/put-supervision-proof';
import type {ControlledSourceUploads,ControlledSourceUploadContext,SourceUploadAccess} from '../test-admission/controlled-source-upload';
import type {PoolClient as UploadClient} from 'pg';
import {AttachmentValidationError} from '../validation/validation-error';
﻿import type {Pool,PoolClient} from 'pg';
import {AttachmentQuotaLedger} from '../attachment-quota-ledger';
import {createReadStream} from 'node:fs';
import {Readable} from 'node:stream';
import {finished} from 'node:stream/promises';
import {transaction} from '../../study-groups/study-group.store';
import {lockAuthorizedDraft} from '../initiation/attachment-draft-repository';
import {AttachmentInitiationUnavailable} from '../initiation/attachment-initiation-repository';
import {AttachmentUploadLedger,type AttachmentUploadFence,type AttachmentReplayFence} from '../upload/attachment-upload-ledger';
import {AttachmentLifecycleLedger} from '../lifecycle/attachment-lifecycle-ledger';
import {withAttachmentUpload,AttachmentUploadError} from '../transport/attachment-upload';
import {sourceByteLimit,type parseAttachmentCapabilities} from '../attachment-policy';
import type {AttachmentStorage,AttachmentPutSupervision} from '../storage/attachment-storage.port';
import type {AttachmentPutClaim} from '../attachment-object-ledger';
import {AttachmentPutSession} from './attachment-put-session';

interface UploadRequest {
 actorId:string;attachmentId:string;contentType:string;contentLength:number;body:Readable;signal?:AbortSignal;
 /** Existing normal authentication/session revalidation; never a client callback. */
 reauthorize:()=>Promise<void>;
}
interface Options {temporaryRoot?:string;controlled?:ControlledSourceUploads;/** Trusted internal local-closure attestation; synchronously enqueue only. */onUncertainPut?:(claim:AttachmentPutClaim,handle:AttachmentPutSupervision)=>void;}
/** Disabled-foundation internal orchestrator. No routes, provider configuration or
 * format activation. Completed upload replay uses its own durable intake fence
 * and full bounded bytes/hash check, without another physical PUT.
 * A storage rejection is an UNKNOWN outcome: retain its held slot and immutable
 * manifest until supervised transport quiescence/reconciliation, never guess from
 * a rejected promise, cancellation request, elapsed lease or negative HEAD.
 */
export class AttachmentUploadService {
 private readonly controlledRetirements=new Map<AttachmentPutSession,{retry:()=>Promise<void>;inFlight?:Promise<void>}>();
 /** Explicit internal retry of retained original request-local proofs only. No scanning, new contexts or workers. */
 async retryControlledRetirements(): Promise<{ remaining: number }> {
   for (const [writes, entry] of this.controlledRetirements) {
     if (entry.inFlight) continue;
     await this.startRetirement(writes, entry).catch(() => undefined);
   }
   return { remaining: this.controlledRetirements.size };
 }
 private startRetirement(
   writes: AttachmentPutSession,
   entry: { retry: () => Promise<void>; inFlight?: Promise<void> },
 ): Promise<void> {
   if (entry.inFlight) return entry.inFlight;
   const attempt = entry.retry();
   entry.inFlight = attempt;
   void attempt.then(
     () => {
       this.controlledRetirements.delete(writes);
       this.unresolvedWrites.delete(writes);
     },
     () => {
       entry.inFlight = undefined;
     },
   );
   return attempt;
 }
 private readonly unresolvedWrites=new Set<AttachmentPutSession>();
 constructor(private readonly pool:Pool,private readonly storage:AttachmentStorage,private readonly capabilities:ReturnType<typeof parseAttachmentCapabilities>,private readonly options:Options={},private readonly uploads=new AttachmentUploadLedger(),private readonly lifecycle=new AttachmentLifecycleLedger(),private readonly quotas=new AttachmentQuotaLedger()){}
 async upload(
   request: UploadRequest,
   context?: ControlledSourceUploadContext,
 ): Promise<{ state: "PENDING" | "READY" }> {
   if (this.options.controlled) {
     if (this.controlledRetirements.size >= 4)
       throw new AttachmentInitiationUnavailable();
     if (!context) throw new AttachmentInitiationUnavailable();
     return this.options.controlled.run(
       context,
       {
         actorId: request.actorId,
         attachmentId: request.attachmentId,
         contentType: request.contentType,
         contentLength: request.contentLength,
       },
       (access) =>
         this.execute(
           {
             ...request,
             signal: request.signal
               ? AbortSignal.any([request.signal, access.signal])
               : access.signal,
           },
           access,
         ),
     );
   }
   if (arguments.length >= 2) throw new AttachmentInitiationUnavailable();
   return this.execute(request);
 }
 private async execute(request:UploadRequest,controlled?:SourceUploadAccess):Promise<{state:'PENDING'|'READY'}>{
  const tx=<T>(work:(client:UploadClient)=>Promise<T>)=>controlled?controlled.stage(client=>work(client)):transaction(this.pool,work);
  let fence:AttachmentUploadFence|undefined,replay:AttachmentReplayFence|undefined;
  const writes=new AttachmentPutSession(this.storage);
  let terminalized=false;
  let controlledClaim:AttachmentPutClaim|undefined,observedResult:Awaited<ReturnType<AttachmentStorage['putTemporary']>>|undefined;
  const inputClosed=async()=>{const stopped=finished(request.body,{cleanup:true}).catch(()=>undefined);request.body.destroy();await stopped;};
  let inputFailed=false;const onInputError=()=>{inputFailed=true;};
  const live=()=>{controlled?.assertForward();if(inputFailed)throw new AttachmentUploadError('UNAVAILABLE');if(request.signal?.aborted)throw new AttachmentUploadError('CANCELLED');};
  try{
   if(!(request.body instanceof Readable)||typeof request.reauthorize!=='function')throw new AttachmentUploadError('INTEGRITY');
   request.body.on('error',onInputError);
   if(!this.capabilities.enabled)throw new AttachmentInitiationUnavailable();
   live();await request.reauthorize();live();
   const preflight=async(client:PoolClient)=>{
    const row=await lockAuthorizedDraft(client,request.actorId,request.attachmentId);
    if(controlled&&row.init_fingerprint!==controlled.initiationFingerprint)throw new AttachmentUploadError('INTEGRITY');
    const enabled=this.capabilities[row.format==='IMAGE'?'image':row.format==='VIDEO'?'video':'text'];
    if(!enabled)throw new AttachmentInitiationUnavailable();
    const declared=(await client.query<{declared_mime:string}>('SELECT declared_mime FROM attachments WHERE id=$1',[row.id])).rows[0];
    if(!declared||request.contentType!==declared.declared_mime)throw new AttachmentValidationError('ATTACHMENT_TYPE_MISMATCH');
    if(!Number.isSafeInteger(request.contentLength)||request.contentLength<1)throw new AttachmentUploadError('INTEGRITY');
    if(request.contentLength>sourceByteLimit(row.format))throw new AttachmentValidationError('ATTACHMENT_LIMIT_EXCEEDED');
    if(request.contentLength!==Number(row.expected_bytes))throw new AttachmentUploadError('INTEGRITY');
    return row;
   };
   const initial=await tx(preflight);
   // Independent rate-only transaction commits the conservative full-body charge.
   // Domain locks are released first; no rate lock survives into domain admission.
   await tx(client=>this.quotas.consumeUploadAttempt(client,request.actorId,Number(initial.expected_bytes)));
   live();await request.reauthorize();live();
   const admission=await tx(async client=>{
    const row=await preflight(client);
    if(controlled&&row.state!=='TEMPORARY')throw new AttachmentUploadError('INTEGRITY');
    if(row.state==='PENDING'||row.state==='READY')return {kind:'replay' as const,fence:await this.uploads.beginReplay(client,request.actorId,request.attachmentId)};
    const admitted=await this.uploads.beginUpload(client,request.actorId,request.attachmentId,controlled?.ids.uploadOwner);if(controlled)fence=admitted;return {kind:'upload' as const,fence:admitted};
   });
   if(admission.kind==='replay'){
    replay=admission.fence;
    const received=await withAttachmentUpload(request.body,replay.expectedBytes,async file=>{
     live();await request.reauthorize();live();
     const bytes={sizeBytes:file.sizeBytes,sha256:file.sha256};
     await transaction(this.pool,client=>this.uploads.verifyCompletedSource(client,request.actorId,request.attachmentId,bytes));
     return bytes;
    },{temporaryRoot:this.options.temporaryRoot,signal:request.signal});
    live();await request.reauthorize();live();
    const result=await transaction(this.pool,client=>this.uploads.verifyCompletedSource(client,request.actorId,request.attachmentId,received));
    await transaction(this.pool,client=>this.lifecycle.settleReplay(client,{attachmentId:replay!.attachmentId,owner:replay!.owner,producerQuiesced:true}));
    replay=undefined;return result;
   }
   fence=admission.fence;
   const admitted=fence;
   const objectId=await withAttachmentUpload(request.body,admitted.expectedBytes,async file=>{
    live();await request.reauthorize();live();
    if(controlled&&(file.sha256!==controlled.sha256||file.sizeBytes!==request.contentLength))throw new AttachmentUploadError('INTEGRITY');
    const prepare=async(client:UploadClient)=>{const claim=await writes.bind(client,await this.uploads.prepareSource(client,request.actorId,admitted,{sizeBytes:file.sizeBytes,sha256:file.sha256},controlled?{objectId:controlled.ids.objectId,attemptId:controlled.ids.attemptId,claimId:controlled.ids.claimId}:undefined),controlled?.supervisionIdentity);if(controlled){controlledClaim=claim;controlled.registerClaim(claim,writes.originalHandle(claim));}return claim;};
    const claim=controlled?await controlled.stage(client=>prepare(client),()=>writes.markCommitAttempt()):await transaction(this.pool,prepare);
    writes.committed();
    // A fresh dispatch gate bounds admission; COMMIT and physical dispatch are not atomic.
    if(controlled)await controlled.stage(async()=>undefined);
    // The immutable claim is committed before opening one exact physical PUT.
    live();
    const body=createReadStream(file.path);
    let observed;
    try{observed=await writes.put(claim,{...claim.manifest,body,signal:request.signal});observedResult=observed;}
    finally{const closed=finished(body,{cleanup:true}).catch(()=>undefined);body.destroy();await closed;}
    // Actual provider results must survive account/group revocation and deletion.
    // This trusted internal transaction grants no read/write user authority.
    const record=(client:UploadClient)=>this.lifecycle.recordPutResult(client,claim,observed,controlled?{ensure:async()=>{throw new AttachmentUploadError('CANCELLED');}}:undefined);
    if(controlled)await controlled.recordSourceReceipt(record);else await tx(record);
    writes.acknowledged(claim);
    return claim.objectId;
   },{temporaryRoot:this.options.temporaryRoot,signal:request.signal});
   if(controlled)await controlled.captureQuiescence(async()=>{});
   live();await request.reauthorize();live();
   const publish=(client:UploadClient)=>this.uploads.markPending(client,request.actorId,admitted,objectId);
   return controlled?await controlled.publishPending(publish):await tx(publish);
  }catch(error){
   if(controlled){
    await inputClosed();
    if(fence){
     const claim=controlledClaim,handle=claim?writes.originalHandle(claim):undefined,pending=handle!==undefined&&originalPutState(handle)==='STARTED';
     const entry={retry:async()=>{
      if(await controlled.reconcilePending()){if(claim)writes.cleanupAcknowledged(claim);writes.releaseResolved();return;}
      await controlled.terminalize(inputClosed,!claim);
      if(claim){await controlled.retire(claim,handle!,inputClosed,observedResult);writes.cleanupAcknowledged(claim);}
      writes.releaseResolved();
     }};
     this.controlledRetirements.set(writes,entry);
     const retirement=this.startRetirement(writes,entry);
     if(!pending)await retirement;
    }
    throw error;
   }
   if(request.body instanceof Readable){const closed=finished(request.body,{cleanup:true}).catch(()=>undefined);request.body.destroy();await closed;}
   if(replay){
    try{await transaction(this.pool,client=>this.lifecycle.settleReplay(client,{attachmentId:replay!.attachmentId,owner:replay!.owner,producerQuiesced:true}));}
    catch(settlementError){throw new AggregateError([error,settlementError],'ATTACHMENT_REPLAY_SETTLEMENT_REQUIRED');}
   }
   if(fence){
    // withAttachmentUpload has awaited input pipeline closure. A positive provider
    // completion establishes local transport settlement; a rejected PUT does not.
    try{
     await transaction(this.pool,client=>this.lifecycle.interruptUpload(client,fence!.attachmentId,fence!.leaseOwner));
     terminalized=true;
    }catch(retirementError){
     // A concurrent tombstone may already have fenced the intake. Settlement below
     // still rechecks exact retained owner; never mask failure by releasing blindly.
     terminalized=await transaction(this.pool,client=>this.lifecycle.terminalProducer(client,fence!.attachmentId,fence!.leaseOwner,'upload'));
     if(!terminalized&&writes.hasUnresolved)throw new AggregateError([error,retirementError],'ATTACHMENT_UPLOAD_RETIREMENT_REQUIRED');
    }
    // The awaited withAttachmentUpload call has closed its input pipeline and
    // temporary files; any opened provider-body stream was awaited in finally.
    for(const proof of terminalized?await writes.retireUnused(async()=>{}):[]){
     await transaction(this.pool,client=>this.lifecycle.abandonUnsent(client,proof.claim,proof.certificate,proof.closure));writes.abandoned(proof.claim);
    }
    if(!writes.hasUnresolved){
     try{await transaction(this.pool,client=>this.lifecycle.settleUpload(client,{attachmentId:fence!.attachmentId,leaseOwner:fence!.leaseOwner,producerQuiesced:true}));}
     catch(settlementError){throw new AggregateError([error,settlementError],'ATTACHMENT_UPLOAD_SETTLEMENT_REQUIRED');}
    }
   }
   throw error;
  }finally{
   if(!controlled||!this.controlledRetirements.has(writes))writes.releaseResolved();
   if(writes.hasUnresolved){this.unresolvedWrites.add(writes);if(!controlled&&terminalized&&this.options.onUncertainPut)try{writes.handoffUnresolved(this.options.onUncertainPut);this.unresolvedWrites.delete(writes);}catch{/* Retain original handles and durable owner when queue admission fails. */}}
   if(request.body instanceof Readable)request.body.removeListener('error',onInputError);
  }
 }
}
