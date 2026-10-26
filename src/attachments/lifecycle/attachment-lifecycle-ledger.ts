import type {PutUnsentCertificate,PutLocalClosure} from '../storage/put-supervision-proof';
import {AttachmentObjectLedger,type AttachmentPutClaim} from '../attachment-object-ledger';
import type {AttachmentStoredObject} from '../storage/attachment-storage.port';
import {AttachmentCleanupLedger,type AttachmentCleanupIdentity,type AttachmentCleanupClaim,type AttachmentCleanupFailure} from '../attachment-cleanup-ledger';
﻿import {randomUUID} from 'node:crypto';import type {PoolClient} from 'pg';
import {authorizeDraftScope,authorizeAttachmentRemoval,opaqueAttachmentAuthorizationError,type AttachmentBoundParent} from '../authorization/attachment-authorization';
import {draftIntent,type DraftRow} from '../initiation/attachment-draft-repository';
import {AttachmentQuotaLedger} from '../attachment-quota-ledger';
import {lockExchangeUsers} from '../../exchange/exchange-pair-authorization';
import {lockExchangePair} from '../../exchange/exchange-safety.repository';
interface Row extends DraftRow {version:string;reserved_bytes:string;lease_owner:string|null;upload_slot_held:boolean;pending_slot_held:boolean;physical_cleanup_at:Date|null;expired:boolean;}
interface Binding {attachment_id:string;scope:DraftRow['scope'];scope_id:string;community_post_id:string|null;group_text_id:string|null;direct_message_id:string|null;removed_at:Date|null;}
export class AttachmentLifecycleError extends Error {constructor(){super('ATTACHMENT_LIFECYCLE_CONFLICT');this.name='AttachmentLifecycleError';}}
const conflict=():never=>{throw new AttachmentLifecycleError();};
const uuid=(v:string)=>{if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v))conflict();};
function parent(b:Binding):AttachmentBoundParent {
 if(b.scope==='COMMUNITY'&&b.community_post_id)return {kind:b.scope,postId:b.community_post_id};
 if(b.scope==='STUDY_GROUP'&&b.group_text_id)return {kind:b.scope,groupId:b.scope_id,textId:b.group_text_id};
 if(b.scope==='DIRECT_MESSAGE'&&b.direct_message_id)return {kind:b.scope,conversationId:b.scope_id,messageId:b.direct_message_id};
 return conflict();
}
/** Internal helper: caller already holds current domain and attachment locks.
 * Call before acquiring quota/singleton locks. No provider I/O. Uncertain
 * producers receive cleanup debt, never absence claims.
 */
export async function scheduleTerminalCleanup(client:PoolClient,attachmentId:string,reason:'EXPIRED'|'INTERRUPTED'|'REJECTED'|'REMOVED'|'MISSING'='REJECTED'):Promise<void>{
 uuid(attachmentId);if(!['EXPIRED','INTERRUPTED','REJECTED','REMOVED','MISSING'].includes(reason))conflict();
 const a=(await client.query<{state:string}>('SELECT state FROM attachments WHERE id=$1 FOR UPDATE',[attachmentId])).rows[0];
 if(!a||!['DELETED','REJECTED'].includes(a.state))return conflict();
 const objects=(await client.query<{id:string;status:string}>("SELECT id,status FROM attachment_objects WHERE attachment_id=$1 ORDER BY id FOR UPDATE",[attachmentId])).rows;
 for(const o of objects){
  if(o.status==='DELETED')continue;
  if(o.status!=='DELETE_PENDING')await client.query("UPDATE attachment_objects SET status='DELETE_PENDING',object_version=object_version+1 WHERE id=$1",[o.id]);
  await client.query(`INSERT INTO attachment_cleanup_jobs(id,attachment_id,object_id,reason) VALUES($1,$2,$3,$4) ON CONFLICT(object_id) WHERE completed_at IS NULL DO NOTHING`,[randomUUID(),attachmentId,o.id,reason]);
 }
}
/** Internal transactional lifecycle. System entry points bypass eligibility solely
 * to retire resources, never to grant access. Quiescence is trusted supervisor
 * evidence after the actual child/transport stops, never a public DTO, elapsed
 * lease, timeout, cancellation request, or negative provider HEAD.
 */
export class AttachmentLifecycleLedger {
 constructor(private readonly quotas=new AttachmentQuotaLedger()){}
 private async candidate(client:PoolClient,id:string){uuid(id);const row=(await client.query<Row>('SELECT * FROM attachments WHERE id=$1',[id])).rows[0];if(!row)return conflict();const binding=(await client.query<Binding>('SELECT * FROM attachment_bindings WHERE attachment_id=$1',[id])).rows[0];return {row,binding};}
 private async systemDomain(client:PoolClient,row:Row,binding:Binding|undefined):Promise<void>{
  if(row.scope==='DIRECT_MESSAGE'){
   const room=(await client.query<{participant_a_id:string;participant_b_id:string}>('SELECT participant_a_id,participant_b_id FROM direct_conversations WHERE id=$1',[row.scope_id])).rows[0];if(!room)return conflict();
   await lockExchangeUsers(client,room.participant_a_id,room.participant_b_id);await lockExchangePair(client,room.participant_a_id,room.participant_b_id);
   if((await client.query('SELECT id FROM direct_conversations WHERE id=$1 AND participant_a_id=$2 AND participant_b_id=$3 FOR UPDATE',[row.scope_id,room.participant_a_id,room.participant_b_id])).rowCount!==1)return conflict();
  }else{
   if((await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[row.uploader_id])).rowCount!==1)return conflict();
   if(row.scope==='STUDY_GROUP'){if((await client.query('SELECT id FROM study_groups WHERE id=$1 FOR UPDATE',[row.scope_id])).rowCount!==1)return conflict();}
   else{if((await client.query('SELECT id FROM languages WHERE id=$1 FOR SHARE',[row.scope_id])).rowCount!==1)return conflict();}
  }
  if(binding){const p=parent(binding);if(p.kind==='COMMUNITY')await client.query('SELECT id FROM community_posts WHERE id=$1 FOR UPDATE',[p.postId]);else if(p.kind==='STUDY_GROUP')await client.query('SELECT id FROM study_group_texts WHERE group_id=$1 AND id=$2 FOR SHARE',[p.groupId,p.textId]);else await client.query('SELECT id FROM direct_messages WHERE conversation_id=$1 AND id=$2 FOR SHARE',[p.conversationId,p.messageId]);}
 }
 private async locked(client:PoolClient,id:string,actor?:string){
  const c=await this.candidate(client,id);
  if(actor!==undefined){
   uuid(actor);if(c.row.uploader_id!==actor)throw opaqueAttachmentAuthorizationError();
   if(c.binding)await authorizeAttachmentRemoval(client,actor,c.row.uploader_id,parent(c.binding));
   else await authorizeDraftScope(client,actor,draftIntent(c.row),c.row.scope_generation);
  }else await this.systemDomain(client,c.row,c.binding);
  const row=(await client.query<Row>('SELECT *,expires_at<=clock_timestamp() AS expired FROM attachments WHERE id=$1 FOR UPDATE',[id])).rows[0];
  const binding=(await client.query<Binding>('SELECT * FROM attachment_bindings WHERE attachment_id=$1 FOR UPDATE',[id])).rows[0];
  if(!row||row.uploader_id!==c.row.uploader_id||row.init_fingerprint!==c.row.init_fingerprint||row.scope_generation!==c.row.scope_generation||JSON.stringify(draftIntent(row))!==JSON.stringify(draftIntent(c.row))||JSON.stringify(binding?parent(binding):null)!==JSON.stringify(c.binding?parent(c.binding):null))return conflict();
  if(actor!==undefined&&!binding&&(row.first_bound_at||row.expired))throw opaqueAttachmentAuthorizationError();
  return {row,binding};
 }
 private async tombstone(client:PoolClient,row:Row,binding:Binding|undefined,reason:'REMOVED'|'EXPIRED'|'INTERRUPTED'){
  if(row.state==='DELETED')return {state:'DELETED' as const};
  // Keep an intake lease as durable ownership until its actual producer stops.
  await client.query(`UPDATE attachments SET state='DELETED',deleted_at=clock_timestamp(),pending_slot_held=false,lease_owner=CASE WHEN upload_slot_held THEN lease_owner ELSE NULL END,lease_expires_at=CASE WHEN upload_slot_held THEN lease_expires_at ELSE NULL END,version=version+1 WHERE id=$1`,[row.id]);
  if(binding&&!binding.removed_at){
   await client.query('UPDATE attachment_bindings SET removed_at=clock_timestamp() WHERE attachment_id=$1',[row.id]);
   if(binding.scope==='STUDY_GROUP')await client.query('UPDATE study_groups SET change_version=change_version+1 WHERE id=$1',[binding.scope_id]);
   else if(binding.scope==='DIRECT_MESSAGE')await client.query('UPDATE direct_conversations SET change_version=change_version+1 WHERE id=$1',[binding.scope_id]);
   else await client.query('UPDATE community_posts SET updated_at=clock_timestamp(),edited_at=clock_timestamp() WHERE id=$1',[binding.community_post_id]);
  }
  await scheduleTerminalCleanup(client,row.id,reason);
  if(row.pending_slot_held)await this.quotas.changeCapacity(client,row.uploader_id,{pendingDelta:-1});
  return {state:'DELETED' as const};
 }
 /** Internal ordered lock boundary only. No read permission, quiescence proof or mutation. */
 async lockForTerminalRetention(client:PoolClient,id:string):Promise<void>{await this.locked(client,id);}
 async terminalProducer(client:PoolClient,id:string,owner:string,producer:'upload'|'processing'):Promise<boolean>{
  uuid(owner);if(!['upload','processing'].includes(producer))return conflict();const {row}=await this.locked(client,id);
  if(!['DELETED','REJECTED'].includes(row.state))return false;
  if(producer==='upload')return row.upload_slot_held&&row.lease_owner===owner;
  const lease=(await client.query<{owner:string|null;attachment_id:string|null}>('SELECT owner,attachment_id FROM attachment_processing_lease WHERE singleton FOR UPDATE')).rows[0];
  return !!lease&&lease.owner===owner&&lease.attachment_id===id;
 }
 async deleteOwned(client:PoolClient,actor:string,id:string):Promise<{state:'DELETED'}>{
  try{const {row,binding}=await this.locked(client,id,actor);return await this.tombstone(client,row,binding,'REMOVED');}
  catch(error){if(error instanceof AttachmentLifecycleError)throw opaqueAttachmentAuthorizationError();throw error;}
 }
 async expireDraft(client:PoolClient,id:string):Promise<{state:'DELETED'}>{const {row,binding}=await this.locked(client,id);if(binding||row.first_bound_at||!row.expired)return conflict();return this.tombstone(client,row,binding,'EXPIRED');}
 async interruptUpload(client:PoolClient,id:string,leaseOwner:string):Promise<{state:'DELETED'}>{uuid(leaseOwner);const {row,binding}=await this.locked(client,id);if(row.state!=='UPLOADING'||row.lease_owner!==leaseOwner||!row.upload_slot_held)return conflict();return this.tombstone(client,row,binding,'INTERRUPTED');}
 /** Internal receipt after the actual replay body/spool transport has stopped.
  * Current user eligibility is irrelevant to releasing retained resource debt.
  * Exact ownership is required; stale owners cannot settle a newer intake. */
 async settleReplay(client:PoolClient,proof:{attachmentId:string;owner:string;producerQuiesced:true}):Promise<void>{
  uuid(proof.owner);if(proof.producerQuiesced!==true)return conflict();
  const {row}=await this.locked(client,proof.attachmentId);
  const replay=(await client.query<{owner:string}>('SELECT owner FROM attachment_upload_replay_leases WHERE attachment_id=$1 FOR UPDATE',[row.id])).rows[0];
  if(!replay||replay.owner!==proof.owner)return conflict();
  await this.quotas.changeCapacity(client,row.uploader_id,{uploadDelta:-1});
  if((await client.query('DELETE FROM attachment_upload_replay_leases WHERE attachment_id=$1 AND owner=$2',[row.id,proof.owner])).rowCount!==1)return conflict();
 }
 async settleUpload(client:PoolClient,proof:{attachmentId:string;leaseOwner:string;producerQuiesced:true}):Promise<void>{
  uuid(proof.leaseOwner);if(proof.producerQuiesced!==true)return conflict();const {row}=await this.locked(client,proof.attachmentId);
  if(!['DELETED','REJECTED'].includes(row.state))return conflict();
  if(!row.upload_slot_held){if(row.lease_owner!==null)return conflict();return;}
  if(row.lease_owner!==proof.leaseOwner)return conflict();
  await this.quotas.changeCapacity(client,row.uploader_id,{uploadDelta:-1});
  await client.query('UPDATE attachments SET upload_slot_held=false,lease_owner=NULL,lease_expires_at=NULL,version=version+1 WHERE id=$1',[row.id]);
 }
 /** Internal rejection after validation/moderation/storage failure. Retain the
  * exact producer fence until its supervisor confirms actual quiescence. */
 async rejectProcessing(client:PoolClient,id:string,owner:string,reason:'INVALID_CONTENT'|'MODERATION_REJECTED'|'MODERATION_PENDING'|'PROCESSING_FAILED'):Promise<void>{
  uuid(owner);if(!['INVALID_CONTENT','MODERATION_REJECTED','MODERATION_PENDING','PROCESSING_FAILED'].includes(reason))return conflict();
  const {row}=await this.locked(client,id);
  if(!['PENDING','REJECTED'].includes(row.state)||row.lease_owner!==owner)return conflict();
  if(row.state==='PENDING'){
   if(!row.pending_slot_held)return conflict();
   await client.query("UPDATE attachments SET state='REJECTED',rejection_code=$2,pending_slot_held=false,version=version+1 WHERE id=$1",[id,reason]);
   await scheduleTerminalCleanup(client,id,'REJECTED');
   await this.quotas.changeCapacity(client,row.uploader_id,{pendingDelta:-1});
  }
  const lease=(await client.query<{owner:string|null;attachment_id:string|null}>('SELECT owner,attachment_id FROM attachment_processing_lease WHERE singleton FOR UPDATE')).rows[0];
  if(!lease||lease.owner!==owner||lease.attachment_id!==id)return conflict();
 }
 async settleProcessing(client:PoolClient,id:string,owner:string,proof:{producerQuiesced:true}):Promise<void>{
  uuid(owner);if(proof.producerQuiesced!==true)return conflict();const {row}=await this.locked(client,id);if(!['DELETED','REJECTED'].includes(row.state))return conflict();
  const lease=(await client.query<{owner:string|null;attachment_id:string|null}>('SELECT owner,attachment_id FROM attachment_processing_lease WHERE singleton FOR UPDATE')).rows[0];
  if(!lease||lease.owner!==owner||lease.attachment_id!==id)return conflict();
  await client.query('UPDATE attachment_processing_lease SET owner=NULL,attachment_id=NULL,expires_at=NULL WHERE singleton');
  if(row.lease_owner===owner)await client.query('UPDATE attachments SET lease_owner=NULL,lease_expires_at=NULL,version=version+1 WHERE id=$1',[id]);
 }
 /** Background transaction adapters: re-enter system domain locks before the
  * cleanup ledger. No provider I/O or user-facing authorization grant. */
 /** Durable infrastructure acknowledgement after a completed PUT, including
  * late results after revoke/delete. This grants no user metadata or byte access;
  * the caller must freshly authorize every subsequent public state transition. */
 async abandonUnsent(client:PoolClient,claim:AttachmentPutClaim,certificate:PutUnsentCertificate,closure:PutLocalClosure):Promise<void>{await this.locked(client,claim.attachmentId);await new AttachmentObjectLedger().abandonUnsent(client,claim,certificate,closure);}
 async recordPutResult(client:PoolClient,claim:AttachmentPutClaim,observed:AttachmentStoredObject):Promise<{acceptedForNextStep:boolean}>{await this.locked(client,claim.attachmentId);return new AttachmentObjectLedger().recordPutResult(client,claim,observed);}
 async claimCleanup(client:PoolClient,id:AttachmentCleanupIdentity,owner:string):Promise<AttachmentCleanupClaim>{await this.locked(client,id.attachmentId);return new AttachmentCleanupLedger().claim(client,id,owner);}
 async finishCleanup(client:PoolClient,claim:AttachmentCleanupClaim):Promise<void>{
  await this.locked(client,claim.attachmentId);
  const observedAt=(await client.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0].now;
  // Internal worker invokes this only after actual exact HEAD/list absence.
  // DB time anchors that post-probe receipt; no host-clock comparison or client DTO.
  await new AttachmentCleanupLedger().finish(client,claim,{confirmedLocator:claim.manifest.locator,headMissing:true,ownedListingResidual:0,observedAt});
 }
 async failCleanup(client:PoolClient,claim:AttachmentCleanupClaim,code:AttachmentCleanupFailure):Promise<void>{await this.locked(client,claim.attachmentId);return new AttachmentCleanupLedger().fail(client,claim,code);}
 async completePhysicalCleanup(client:PoolClient,id:string):Promise<void>{
  const {row}=await this.locked(client,id);if(!['DELETED','REJECTED'].includes(row.state))return conflict();if(row.physical_cleanup_at)return;
  if(row.upload_slot_held||row.pending_slot_held||row.lease_owner!==null)return conflict();
  if((await client.query('SELECT attachment_id FROM attachment_upload_replay_leases WHERE attachment_id=$1 FOR UPDATE',[id])).rowCount)return conflict();
  const objects=(await client.query<{status:string;put_uncertain:boolean;put_claim:string|null;put_settled_at:Date|null;put_abandoned_at:Date|null}>('SELECT status,put_uncertain,put_claim,put_settled_at,put_abandoned_at FROM attachment_objects WHERE attachment_id=$1 ORDER BY id FOR UPDATE',[id])).rows;
  const jobs=(await client.query<{completed_at:Date|null;lease_owner:string|null}>('SELECT completed_at,lease_owner FROM attachment_cleanup_jobs WHERE attachment_id=$1 ORDER BY id FOR UPDATE',[id])).rows;
  if(objects.some(o=>o.status!=='DELETED'||o.put_uncertain||(o.put_claim!==null&&o.put_settled_at===null&&!o.put_abandoned_at))||jobs.some(j=>!j.completed_at||j.lease_owner!==null))return conflict();
  // Quota rows precede the singleton lease. Failure below rolls back all counters.
  await this.quotas.changeCapacity(client,row.uploader_id,{bytesDelta:-Number(row.reserved_bytes),metadataDelta:-1});
  const processing=(await client.query<{owner:string|null;attachment_id:string|null}>('SELECT owner,attachment_id FROM attachment_processing_lease WHERE singleton FOR UPDATE')).rows[0];
  if(!processing||(processing.owner!==null&&processing.attachment_id===id))return conflict();
  await client.query('UPDATE attachments SET physical_cleanup_at=clock_timestamp(),version=version+1 WHERE id=$1',[id]);
 }
}
