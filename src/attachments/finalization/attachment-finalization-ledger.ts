import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {CommunityPostType,CommunityVisibility} from '../../community/community.types';
import {authorizeDraftScope,opaqueAttachmentAuthorizationError,type AttachmentDraftIntent} from '../authorization/attachment-authorization';
import {AttachmentObjectLedger,type AttachmentPutClaim} from '../attachment-object-ledger';
import {AttachmentQuotaLedger} from '../attachment-quota-ledger';
import {ATTACHMENT_LIMITS as L,type AttachmentFormat} from '../attachment-policy';
import type {AttachmentStoredObject} from '../storage/attachment-storage.port';
import {processorProofFacts,type ValidatedProcessorProof,type ProcessorProofFacts} from './processor-proof';
export class AttachmentFinalizationError extends Error {readonly code='ATTACHMENT_FINALIZATION_CONFLICT';constructor(){super('ATTACHMENT_FINALIZATION_CONFLICT');}}
const conflict=():never=>{throw new AttachmentFinalizationError();};
const uuid=(value:string)=>{if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))return conflict();};
export interface AttachmentProcessingFence {attachmentId:string;attachmentVersion:number;leaseOwner:string;source:AttachmentStoredObject}
declare const planBrand:unique symbol;
export interface AttachmentPreparedArtifacts {readonly [planBrand]:true;readonly claims:readonly AttachmentPutClaim[]}
interface Plan {fence:AttachmentProcessingFence;facts:ProcessorProofFacts;claims:AttachmentPutClaim[]}
const plans=new WeakMap<AttachmentPreparedArtifacts,Plan>();
interface Row {
 id:string;uploader_id:string;scope:AttachmentDraftIntent['kind'];scope_id:string;scope_generation:string|null;community_post_type:CommunityPostType|null;community_visibility:CommunityVisibility|null;
 state:string;version:string;valid:boolean;lease_valid:boolean;lease_owner:string|null;first_bound_at:Date|null;source_object_id:string|null;normalized_object_id:string|null;thumbnail_object_id:string|null;pending_slot_held:boolean;
 init_fingerprint:string;format:AttachmentFormat;expected_bytes:string;declared_mime:string;display_filename:string;
}
interface ObjectRow {id:string;attachment_id:string;attempt_id:string;variant:'source'|'normalized'|'thumbnail';byte_count:string;sha256:string;etag:string|null;status:string;put_claim:string|null;put_settled_at:Date|null;put_uncertain:boolean;content_type:string;}
function intent(row:Row):AttachmentDraftIntent{
 if(row.scope==='STUDY_GROUP')return {kind:row.scope,groupId:row.scope_id};if(row.scope==='DIRECT_MESSAGE')return {kind:row.scope,conversationId:row.scope_id};
 if(row.scope!=='COMMUNITY'||!row.community_post_type||!row.community_visibility)throw opaqueAttachmentAuthorizationError();return {kind:row.scope,languageId:row.scope_id,postType:row.community_post_type,visibility:row.community_visibility};
}
function stored(row:ObjectRow):AttachmentStoredObject {if(row.status!=='WRITTEN'||row.put_uncertain||!row.put_claim||!row.put_settled_at||!row.etag)return conflict();return {locator:{attachmentId:row.attachment_id,attemptId:row.attempt_id,objectId:row.id,kind:row.variant},sizeBytes:Number(row.byte_count),sha256:row.sha256,version:row.etag};}
function exact(a:AttachmentStoredObject,b:AttachmentStoredObject):boolean{return !!b&&a.sizeBytes===b.sizeBytes&&a.sha256===b.sha256&&a.version===b.version&&Object.entries(a.locator).every(([key,value])=>b.locator?.[key as keyof typeof a.locator]===value);}
/** INTERNAL READ COMMITTED transaction port: every error requires whole rollback.
 * No provider/native I/O or public DTO. Commit claims before I/O, then supply fresh
 * independently verified HEAD snapshots for every exact selected artifact. Process
 * and physical PUT producers must be closed before publication releases the lease.
 * Never infer quiescence from elapsed time, process boot or expired lease.
 */
export class AttachmentFinalizationLedger {
 constructor(private readonly quotas=new AttachmentQuotaLedger(),private readonly objects=new AttachmentObjectLedger()){}
 private async locked(client:PoolClient,actor:string,id:string):Promise<Row>{
  uuid(actor);uuid(id);const candidate=(await client.query<Row>('SELECT * FROM attachments WHERE id=$1 AND uploader_id=$2',[id,actor])).rows[0];if(!candidate)throw opaqueAttachmentAuthorizationError();
  await authorizeDraftScope(client,actor,intent(candidate),candidate.scope_generation);
  const row=(await client.query<Row>('SELECT *,expires_at>clock_timestamp() AS valid,lease_expires_at>clock_timestamp() AS lease_valid FROM attachments WHERE id=$1 AND uploader_id=$2 FOR UPDATE',[id,actor])).rows[0];
  if(!row||row.init_fingerprint!==candidate.init_fingerprint||row.scope!==candidate.scope||row.scope_id!==candidate.scope_id||row.scope_generation!==candidate.scope_generation||JSON.stringify(intent(row))!==JSON.stringify(intent(candidate))||!row.valid||row.first_bound_at)throw opaqueAttachmentAuthorizationError();
  if((await client.query('SELECT 1 FROM attachment_bindings WHERE attachment_id=$1',[id])).rowCount)throw opaqueAttachmentAuthorizationError();return row;
 }
 private fence(row:Row,fence:AttachmentProcessingFence):void{
  uuid(fence.leaseOwner);if(row.id!==fence.attachmentId||row.state!=='PENDING'||!row.pending_slot_held||!row.lease_valid||row.lease_owner!==fence.leaseOwner||!Number.isSafeInteger(fence.attachmentVersion)||Number(row.version)!==fence.attachmentVersion||row.source_object_id!==fence.source.locator.objectId)return conflict();
 }
 private async singleton(client:PoolClient,row:Row,fence:AttachmentProcessingFence):Promise<void>{
  const lease=(await client.query<{owner:string|null;attachment_id:string|null;valid:boolean}>('SELECT *,expires_at>clock_timestamp() AS valid FROM attachment_processing_lease WHERE singleton FOR UPDATE')).rows[0];
  if(!lease||lease.owner!==fence.leaseOwner||lease.attachment_id!==row.id||!lease.valid)return conflict();
 }
 private async source(client:PoolClient,row:Row):Promise<AttachmentStoredObject>{
  const source=(await client.query<ObjectRow>("SELECT * FROM attachment_objects WHERE attachment_id=$1 AND id=$2 AND variant='source' FOR UPDATE",[row.id,row.source_object_id])).rows[0];
  if(!source||source.content_type!=='application/octet-stream'||Number(source.byte_count)!==Number(row.expected_bytes))return conflict();return stored(source);
 }
 async claimProcessing(client:PoolClient,actor:string,attachmentId:string):Promise<AttachmentProcessingFence>{
  const row=await this.locked(client,actor,attachmentId);
  if(row.state!=='PENDING'||!row.pending_slot_held||row.lease_owner!==null||row.normalized_object_id||row.thumbnail_object_id)return conflict();
  const source=await this.source(client,row);
  if((await client.query("SELECT 1 FROM attachment_objects WHERE attachment_id=$1 AND variant<>'source' AND status<>'DELETED' LIMIT 1",[row.id])).rowCount)return conflict();
  const lease=(await client.query<{owner:string|null;attachment_id:string|null;expires_at:Date|null}>('SELECT * FROM attachment_processing_lease WHERE singleton FOR UPDATE')).rows[0];
  if(!lease||lease.owner!==null||lease.attachment_id!==null||lease.expires_at!==null)return conflict();
  const leaseOwner=randomUUID(),next=(await client.query<{version:string;lease_expires_at:Date}>(`UPDATE attachments SET lease_owner=$2,lease_expires_at=clock_timestamp()+$3*interval '1 millisecond',version=version+1 WHERE id=$1 RETURNING version,lease_expires_at`,[row.id,leaseOwner,L.processingLeaseMs])).rows[0];
  await client.query('UPDATE attachment_processing_lease SET owner=$1,attachment_id=$2,expires_at=$3 WHERE singleton',[leaseOwner,row.id,next.lease_expires_at]);
  return {attachmentId:row.id,attachmentVersion:Number(next.version),leaseOwner,source};
 }
 async prepareArtifacts(client:PoolClient,actor:string,fence:AttachmentProcessingFence,proof:ValidatedProcessorProof,bindSupervision?:(claim:AttachmentPutClaim)=>Promise<AttachmentPutClaim>):Promise<AttachmentPreparedArtifacts>{
  const facts=processorProofFacts(proof),row=await this.locked(client,actor,fence.attachmentId);this.fence(row,fence);const source=await this.source(client,row);
  if(!exact(source,fence.source)||facts.format!==row.format||facts.sourceBytes!==Number(row.expected_bytes)||facts.sourceSha256!==source.sha256||facts.filename!==row.display_filename||facts.mime!==row.declared_mime||row.normalized_object_id||row.thumbnail_object_id)return conflict();
  if((await client.query("SELECT 1 FROM attachment_objects WHERE attachment_id=$1 AND variant<>'source' AND status<>'DELETED' LIMIT 1",[row.id])).rowCount)return conflict();
  const attempt=randomUUID(),entries=facts.artifacts.map(artifact=>({artifact,id:randomUUID()})).sort((a,b)=>a.id<b.id?-1:1),claims:AttachmentPutClaim[]=[];
  for(const {artifact,id} of entries){await client.query('INSERT INTO attachment_objects(id,attachment_id,attempt_id,variant,sha256,byte_count,content_type) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,row.id,attempt,artifact.variant,artifact.sha256,artifact.sizeBytes,artifact.contentType]);const claim=await this.objects.claimPut(client,row.id,id,fence,randomUUID());claims.push(bindSupervision?await bindSupervision(claim):claim);}
  await this.singleton(client,row,fence);
  const frozen=Object.freeze({claims:Object.freeze(structuredClone(claims))}) as unknown as AttachmentPreparedArtifacts;
  plans.set(frozen,{fence:structuredClone(fence),facts,claims:structuredClone(claims)});return frozen;
 }
 async publishReady(client:PoolClient,actor:string,prepared:AttachmentPreparedArtifacts,verifiedHeads:readonly AttachmentStoredObject[]):Promise<{state:'READY'}>{
  const plan=plans.get(prepared);if(!plan)return conflict();const {fence,facts,claims}=plan,row=await this.locked(client,actor,fence.attachmentId);
  const selected=Object.fromEntries(claims.map(claim=>[claim.manifest.locator.kind,claim.objectId]));
  if(row.state==='READY'){if(row.normalized_object_id!==selected.normalized||row.thumbnail_object_id!==(selected.thumbnail??null)||row.source_object_id!==fence.source.locator.objectId)return conflict();return {state:'READY'};}
  this.fence(row,fence);
  const ids=[row.source_object_id!,...claims.map(claim=>claim.objectId)].sort();
  const rows=(await client.query<ObjectRow>('SELECT * FROM attachment_objects WHERE attachment_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[row.id,ids])).rows;
  if(rows.length!==ids.length||verifiedHeads.length!==ids.length||new Set(verifiedHeads.map(head=>head.locator.objectId)).size!==ids.length)return conflict();
  for(const object of rows){
   const receipt=stored(object),head=verifiedHeads.find(h=>h.locator.objectId===object.id);if(!head||!exact(receipt,head))return conflict();
   if(object.id===row.source_object_id){if(!exact(receipt,fence.source))return conflict();continue;}
   const artifact=facts.artifacts.find(a=>a.variant===object.variant),claim=claims.find(c=>c.objectId===object.id);
   if(!artifact||!claim||object.put_claim!==claim.claimId||object.byte_count!==String(artifact.sizeBytes)||object.sha256!==artifact.sha256||object.content_type!==artifact.contentType||!exact({...claim.manifest,version:receipt.version},receipt))return conflict();
  }
  await client.query(`INSERT INTO attachment_cleanup_jobs(id,attachment_id,object_id,reason) VALUES($1,$2,$3,'ORPHAN') ON CONFLICT(object_id) WHERE completed_at IS NULL DO NOTHING`,[randomUUID(),row.id,row.source_object_id]);
  // Quota rows precede singleton lease. A late lease conflict rolls back the quota
  // mutation and every DB effect; never release physical byte/metadata debt here.
  await this.quotas.changeCapacity(client,actor,{pendingDelta:-1});await this.singleton(client,row,fence);
  await client.query(`UPDATE attachments SET state='READY',normalized_object_id=$2,thumbnail_object_id=$3,lease_owner=NULL,lease_expires_at=NULL,pending_slot_held=false,version=version+1 WHERE id=$1`,[row.id,selected.normalized,selected.thumbnail??null]);
  await client.query('UPDATE attachment_processing_lease SET owner=NULL,attachment_id=NULL,expires_at=NULL WHERE singleton');

  return {state:'READY'};
 }
}
