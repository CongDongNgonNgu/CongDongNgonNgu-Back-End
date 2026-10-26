import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {ATTACHMENT_LIMITS as L} from '../attachment-policy';
import {AttachmentQuotaLedger} from '../attachment-quota-ledger';
import {AttachmentObjectLedger,type AttachmentPutClaim} from '../attachment-object-ledger';
import {authorizeDraftScope,opaqueAttachmentAuthorizationError,type AttachmentDraftIntent} from '../authorization/attachment-authorization';
import type {CommunityPostType,CommunityVisibility} from '../../community/community.types';

export interface AttachmentUploadFence {attachmentId:string;attachmentVersion:number;leaseOwner:string;expectedBytes:number;}
export interface AttachmentReplayFence {attachmentId:string;owner:string;expectedBytes:number;}
export interface AttachmentReceivedBytes {sizeBytes:number;sha256:string;}
export class AttachmentUploadStateError extends Error {
 constructor(readonly code:'CONFLICT'|'INTEGRITY'){super('ATTACHMENT_UPLOAD_'+code);this.name='AttachmentUploadStateError';}
}
interface Row {
 id:string;uploader_id:string;scope:AttachmentDraftIntent['kind'];scope_id:string;scope_generation:string|null;
 community_post_type:CommunityPostType|null;community_visibility:CommunityVisibility|null;
 state:string;version:string;expected_bytes:string;first_bound_at:Date|null;source_object_id:string|null;
 lease_owner:string|null;lease_valid:boolean;valid:boolean;init_fingerprint:string;upload_slot_held:boolean;pending_slot_held:boolean;
}
const uuid=(v:string)=>{if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v))throw opaqueAttachmentAuthorizationError();};
const conflict=():never=>{throw new AttachmentUploadStateError('CONFLICT');};
function intent(row:Row):AttachmentDraftIntent {
 if(row.scope==='STUDY_GROUP')return {kind:row.scope,groupId:row.scope_id};
 if(row.scope==='DIRECT_MESSAGE')return {kind:row.scope,conversationId:row.scope_id};
 if(row.scope!=='COMMUNITY'||!row.community_post_type||!row.community_visibility)throw opaqueAttachmentAuthorizationError();
 return {kind:row.scope,languageId:row.scope_id,postType:row.community_post_type,visibility:row.community_visibility};
}
/** Internal READ COMMITTED transaction port. Commit beginUpload before receiving a
 * body; commit prepareSource before its single physical PUT. No I/O, routes, format
 * activation or READY promotion occur here. Every error requires full rollback.
 * Unknown source writes retain their key and reservation; recover only after their
 * independent cleanup. Completed-body replay intake needs caller admission/bounds.
 */
export class AttachmentUploadLedger {
 constructor(private readonly quotas=new AttachmentQuotaLedger(),private readonly objects=new AttachmentObjectLedger()){}
 private async locked(client:PoolClient,actor:string,id:string):Promise<Row>{
  uuid(actor);uuid(id);
  const candidate=(await client.query<Row>('SELECT * FROM attachments WHERE id=$1 AND uploader_id=$2',[id,actor])).rows[0];
  if(!candidate)throw opaqueAttachmentAuthorizationError();
  await authorizeDraftScope(client,actor,intent(candidate),candidate.scope_generation);
  const row=(await client.query<Row>(`SELECT *,expires_at>clock_timestamp() AS valid,lease_expires_at>clock_timestamp() AS lease_valid FROM attachments WHERE id=$1 AND uploader_id=$2 FOR UPDATE`,[id,actor])).rows[0];
  if(!row||row.init_fingerprint!==candidate.init_fingerprint||row.scope!==candidate.scope||row.scope_id!==candidate.scope_id||row.scope_generation!==candidate.scope_generation||JSON.stringify(intent(row))!==JSON.stringify(intent(candidate))||!row.valid||row.first_bound_at)throw opaqueAttachmentAuthorizationError();
  if((await client.query('SELECT 1 FROM attachment_bindings WHERE attachment_id=$1',[id])).rowCount)throw opaqueAttachmentAuthorizationError();
  return row;
 }
 private fence(row:Row,fence:AttachmentUploadFence):void{
  uuid(fence.leaseOwner);
  if(row.state!=='UPLOADING'||!row.lease_valid||row.lease_owner!==fence.leaseOwner||!Number.isSafeInteger(fence.attachmentVersion)||Number(row.version)!==fence.attachmentVersion||Number(row.expected_bytes)!==fence.expectedBytes)conflict();
 }
 async beginUpload(client:PoolClient,actor:string,attachmentId:string):Promise<AttachmentUploadFence>{
  const row=await this.locked(client,actor,attachmentId);
  // Expiry alone cannot establish that the previous raw intake has stopped.
  // Failed/expired producers must interrupt and settle before a new initiation.
  if(row.state!=='TEMPORARY')return conflict();
  // Even a never-started reserved key is retired through cleanup, never overwritten.
  if((await client.query("SELECT 1 FROM attachment_objects WHERE attachment_id=$1 AND status<>'DELETED' LIMIT 1",[attachmentId])).rowCount)return conflict();
  if(row.upload_slot_held||row.pending_slot_held)return conflict();
  if(row.state==='TEMPORARY')await this.quotas.changeCapacity(client,actor,{uploadDelta:1});
  const leaseOwner=randomUUID();
  const next=(await client.query<{version:string}>(`UPDATE attachments SET state='UPLOADING',upload_slot_held=true,version=version+1,lease_owner=$2,lease_expires_at=clock_timestamp()+$3*interval '1 millisecond',updated_at=clock_timestamp() WHERE id=$1 RETURNING version`,[attachmentId,leaseOwner,L.uploadLeaseMs])).rows[0];
  return {attachmentId,attachmentVersion:Number(next.version),leaseOwner,expectedBytes:Number(row.expected_bytes)};
 }
 /** Commit durable completed-body intake admission before accepting any bytes.
  * This lease is independent of processing and never stolen on expiry. */
 async beginReplay(client:PoolClient,actor:string,attachmentId:string):Promise<AttachmentReplayFence>{
  const row=await this.locked(client,actor,attachmentId);
  if(!['PENDING','READY'].includes(row.state)||!row.source_object_id||row.upload_slot_held)return conflict();
  const source=(await client.query<{byte_count:string;put_claim:string|null;put_settled_at:Date|null;put_uncertain:boolean;etag:string|null;sha256:string}>(`SELECT byte_count,put_claim,put_settled_at,put_uncertain,etag,sha256 FROM attachment_objects WHERE attachment_id=$1 AND id=$2 AND variant='source' FOR UPDATE`,[row.id,row.source_object_id])).rows[0];
  if(!source||Number(source.byte_count)!==Number(row.expected_bytes)||!source.put_claim||!source.put_settled_at||source.put_uncertain||!source.etag||!/^[a-f0-9]{64}$/.test(source.sha256))return conflict();
  if((await client.query('SELECT owner FROM attachment_upload_replay_leases WHERE attachment_id=$1 FOR UPDATE',[row.id])).rowCount)return conflict();
  await this.quotas.changeCapacity(client,actor,{uploadDelta:1});
  const owner=randomUUID();
  await client.query(`INSERT INTO attachment_upload_replay_leases(attachment_id,owner,expires_at) VALUES($1,$2,clock_timestamp()+$3*interval '1 millisecond')`,[row.id,owner,L.uploadLeaseMs]);
  return {attachmentId:row.id,owner,expectedBytes:Number(row.expected_bytes)};
 }
 async prepareSource(client:PoolClient,actor:string,fence:AttachmentUploadFence,received:AttachmentReceivedBytes):Promise<AttachmentPutClaim>{
  const row=await this.locked(client,actor,fence.attachmentId);this.fence(row,fence);
  if(!Number.isSafeInteger(received.sizeBytes)||received.sizeBytes!==Number(row.expected_bytes)||!/^[a-f0-9]{64}$/.test(received.sha256))throw new AttachmentUploadStateError('INTEGRITY');
  if((await client.query("SELECT 1 FROM attachment_objects WHERE attachment_id=$1 AND status<>'DELETED' LIMIT 1",[row.id])).rowCount)return conflict();
  const objectId=randomUUID(),attemptId=randomUUID();
  await client.query(`INSERT INTO attachment_objects(id,attachment_id,attempt_id,variant,sha256,byte_count,content_type) VALUES($1,$2,$3,'source',$4,$5,'application/octet-stream')`,[objectId,row.id,attemptId,received.sha256,received.sizeBytes]);
  return this.objects.claimPut(client,row.id,objectId,fence,randomUUID());
 }
 async markPending(client:PoolClient,actor:string,fence:AttachmentUploadFence,objectId:string):Promise<{state:'PENDING'}>{
  const row=await this.locked(client,actor,fence.attachmentId);uuid(objectId);
  const source=(await client.query<{byte_count:string;status:string;put_uncertain:boolean;put_settled_at:Date|null;etag:string|null}>(`SELECT byte_count,status,put_uncertain,put_settled_at,etag FROM attachment_objects WHERE attachment_id=$1 AND id=$2 AND variant='source' FOR UPDATE`,[row.id,objectId])).rows[0];
  if(!source||Number(source.byte_count)!==Number(row.expected_bytes)||source.status!=='WRITTEN'||source.put_uncertain||!source.put_settled_at||!source.etag)return conflict();
  if(row.state==='PENDING'){if(row.source_object_id!==objectId)return conflict();return {state:'PENDING'};}
  this.fence(row,fence);
  if(!row.upload_slot_held||row.pending_slot_held)return conflict();
  await this.quotas.changeCapacity(client,actor,{uploadDelta:-1,pendingDelta:1});
  await client.query(`UPDATE attachments SET state='PENDING',upload_slot_held=false,pending_slot_held=true,source_object_id=$2,version=version+1,lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE id=$1`,[row.id,objectId]);
  return {state:'PENDING'};
 }
 async verifyCompletedSource(client:PoolClient,actor:string,attachmentId:string,received:AttachmentReceivedBytes):Promise<{state:'PENDING'|'READY'}>{
  const row=await this.locked(client,actor,attachmentId);
  if(!['PENDING','READY'].includes(row.state))return conflict();
  if(!Number.isSafeInteger(received.sizeBytes)||received.sizeBytes!==Number(row.expected_bytes)||!/^[a-f0-9]{64}$/.test(received.sha256))throw new AttachmentUploadStateError('INTEGRITY');
  // Source originals may be physically removed after validation; their immutable
  // settled receipt remains the replay fingerprint and grants no byte access.
  const sources=(await client.query<{sha256:string;byte_count:string}>(`SELECT sha256,byte_count FROM attachment_objects WHERE attachment_id=$1 AND id=$2 AND variant='source' AND put_settled_at IS NOT NULL AND NOT put_uncertain`,[row.id,row.source_object_id])).rows;
  if(sources.length!==1||sources[0].sha256!==received.sha256||Number(sources[0].byte_count)!==received.sizeBytes)throw new AttachmentUploadStateError('INTEGRITY');
  return {state:row.state as 'PENDING'|'READY'};
 }
}
