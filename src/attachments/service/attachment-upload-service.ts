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
interface Options {temporaryRoot?:string;/** Trusted internal local-closure attestation; synchronously enqueue only. */onUncertainPut?:(claim:AttachmentPutClaim,handle:AttachmentPutSupervision)=>void;}
/** Disabled-foundation internal orchestrator. No routes, provider configuration or
 * format activation. Completed upload replay uses its own durable intake fence
 * and full bounded bytes/hash check, without another physical PUT.
 * A storage rejection is an UNKNOWN outcome: retain its held slot and immutable
 * manifest until supervised transport quiescence/reconciliation, never guess from
 * a rejected promise, cancellation request, elapsed lease or negative HEAD.
 */
export class AttachmentUploadService {
 private readonly unresolvedWrites=new Set<AttachmentPutSession>();
 constructor(private readonly pool:Pool,private readonly storage:AttachmentStorage,private readonly capabilities:ReturnType<typeof parseAttachmentCapabilities>,private readonly options:Options={},private readonly uploads=new AttachmentUploadLedger(),private readonly lifecycle=new AttachmentLifecycleLedger(),private readonly quotas=new AttachmentQuotaLedger()){}
 async upload(request:UploadRequest):Promise<{state:'PENDING'|'READY'}>{
  let fence:AttachmentUploadFence|undefined,replay:AttachmentReplayFence|undefined;
  const writes=new AttachmentPutSession(this.storage);
  let terminalized=false;
  let inputFailed=false;const onInputError=()=>{inputFailed=true;};
  const live=()=>{if(inputFailed)throw new AttachmentUploadError('UNAVAILABLE');if(request.signal?.aborted)throw new AttachmentUploadError('CANCELLED');};
  try{
   if(!(request.body instanceof Readable)||typeof request.reauthorize!=='function')throw new AttachmentUploadError('INTEGRITY');
   request.body.on('error',onInputError);
   if(!this.capabilities.enabled)throw new AttachmentInitiationUnavailable();
   live();await request.reauthorize();live();
   const preflight=async(client:PoolClient)=>{
    const row=await lockAuthorizedDraft(client,request.actorId,request.attachmentId);
    const enabled=this.capabilities[row.format==='IMAGE'?'image':row.format==='VIDEO'?'video':'text'];
    if(!enabled)throw new AttachmentInitiationUnavailable();
    const declared=(await client.query<{declared_mime:string}>('SELECT declared_mime FROM attachments WHERE id=$1',[row.id])).rows[0];
    if(!declared||request.contentType!==declared.declared_mime)throw new AttachmentValidationError('ATTACHMENT_TYPE_MISMATCH');
    if(!Number.isSafeInteger(request.contentLength)||request.contentLength<1)throw new AttachmentUploadError('INTEGRITY');
    if(request.contentLength>sourceByteLimit(row.format))throw new AttachmentValidationError('ATTACHMENT_LIMIT_EXCEEDED');
    if(request.contentLength!==Number(row.expected_bytes))throw new AttachmentUploadError('INTEGRITY');
    return row;
   };
   const initial=await transaction(this.pool,preflight);
   // Independent rate-only transaction commits the conservative full-body charge.
   // Domain locks are released first; no rate lock survives into domain admission.
   await transaction(this.pool,client=>this.quotas.consumeUploadAttempt(client,request.actorId,Number(initial.expected_bytes)));
   live();await request.reauthorize();live();
   const admission=await transaction(this.pool,async client=>{
    const row=await preflight(client);
    if(row.state==='PENDING'||row.state==='READY')return {kind:'replay' as const,fence:await this.uploads.beginReplay(client,request.actorId,request.attachmentId)};
    return {kind:'upload' as const,fence:await this.uploads.beginUpload(client,request.actorId,request.attachmentId)};
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
    const claim=await transaction(this.pool,async client=>writes.bind(client,await this.uploads.prepareSource(client,request.actorId,admitted,{sizeBytes:file.sizeBytes,sha256:file.sha256})));
    writes.committed();
    // The immutable claim is committed before opening one exact physical PUT.
    live();
    const body=createReadStream(file.path);
    let observed;
    try{observed=await writes.put(claim,{...claim.manifest,body,signal:request.signal});}
    finally{const closed=finished(body,{cleanup:true}).catch(()=>undefined);body.destroy();await closed;}
    // Actual provider results must survive account/group revocation and deletion.
    // This trusted internal transaction grants no read/write user authority.
    await transaction(this.pool,client=>this.lifecycle.recordPutResult(client,claim,observed));
    writes.acknowledged(claim);
    return claim.objectId;
   },{temporaryRoot:this.options.temporaryRoot,signal:request.signal});
   live();await request.reauthorize();live();
   return await transaction(this.pool,client=>this.uploads.markPending(client,request.actorId,admitted,objectId));
  }catch(error){
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
   writes.releaseResolved();
   if(writes.hasUnresolved){this.unresolvedWrites.add(writes);if(terminalized&&this.options.onUncertainPut)try{writes.handoffUnresolved(this.options.onUncertainPut);this.unresolvedWrites.delete(writes);}catch{/* Retain original handles and durable owner when queue admission fails. */}}
   if(request.body instanceof Readable)request.body.removeListener('error',onInputError);
  }
 }
}
