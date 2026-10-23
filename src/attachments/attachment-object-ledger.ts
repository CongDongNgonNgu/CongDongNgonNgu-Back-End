import type {PoolClient} from 'pg';
import type {AttachmentStoredObject,AttachmentObjectLocator} from './storage/attachment-storage.port';
export class AttachmentLedgerError extends Error {
 constructor(readonly code:'CLAIM_CONFLICT'|'INTEGRITY'){super('ATTACHMENT_OBJECT_'+code);this.name='AttachmentLedgerError';}
}
export interface AttachmentPutClaim {
 attachmentId:string;objectId:string;claimId:string;attachmentVersion:number;leaseOwner:string;objectVersion:number;
 manifest:{locator:AttachmentObjectLocator;sizeBytes:number;sha256:string};
}
interface ObjectRow {id:string;attachment_id:string;attempt_id:string;variant:AttachmentObjectLocator['kind'];byte_count:string;sha256:string;etag:string|null;object_version:string;put_claim:string|null;put_settled_at:Date|null;status:string;}
const fail=(code:'CLAIM_CONFLICT'|'INTEGRITY'):never=>{throw new AttachmentLedgerError(code);};
const uuid=(v:string)=>{if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v))fail('CLAIM_CONFLICT');};
function manifest(row:ObjectRow){return {locator:{attachmentId:row.attachment_id,attemptId:row.attempt_id,objectId:row.id,kind:row.variant},sizeBytes:Number(row.byte_count),sha256:row.sha256};}
/** Internal transactional ledger. Caller holds current domain/account locks first.
 * This port never authorizes user access, promotes READY, or performs provider I/O.
 * Commit the claim before one physical PUT; a consumed key is never retried.
 */
export class AttachmentObjectLedger {
 async claimPut(client:PoolClient,attachmentId:string,objectId:string,fence:{attachmentVersion:number;leaseOwner:string},claimId:string):Promise<AttachmentPutClaim>{
  [attachmentId,objectId,fence.leaseOwner,claimId].forEach(uuid);
  const a=(await client.query<{state:string;version:string;lease_owner:string|null;valid:boolean}>(`SELECT state,version,lease_owner,(lease_expires_at>clock_timestamp() AND expires_at>clock_timestamp()) AS valid FROM attachments WHERE id=$1 FOR UPDATE`,[attachmentId])).rows[0];
  if(!a||!Number.isSafeInteger(fence.attachmentVersion)||Number(a.version)!==fence.attachmentVersion||a.lease_owner!==fence.leaseOwner||!a.valid||!['UPLOADING','PENDING'].includes(a.state))return fail('CLAIM_CONFLICT');
  const row=(await client.query<ObjectRow>(`UPDATE attachment_objects SET put_claim=$3,put_claimed_at=clock_timestamp(),put_uncertain=true,object_version=object_version+1
   WHERE attachment_id=$1 AND id=$2 AND put_claim IS NULL AND status='RESERVED'
    AND ((variant='source' AND $4='UPLOADING') OR (variant<>'source' AND $4='PENDING')) RETURNING *`,[attachmentId,objectId,claimId,a.state])).rows[0];
  if(!row)return fail('CLAIM_CONFLICT');
  return {attachmentId,objectId,claimId,attachmentVersion:fence.attachmentVersion,leaseOwner:fence.leaseOwner,objectVersion:Number(row.object_version),manifest:manifest(row)};
 }
 async recordPutResult(client:PoolClient,claim:AttachmentPutClaim,observed:AttachmentStoredObject):Promise<{acceptedForNextStep:boolean}>{
  const a=(await client.query<{state:string;version:string;lease_owner:string|null;valid:boolean}>(`SELECT state,version,lease_owner,(lease_expires_at>clock_timestamp() AND expires_at>clock_timestamp()) AS valid FROM attachments WHERE id=$1 FOR UPDATE`,[claim.attachmentId])).rows[0];
  const o=(await client.query<ObjectRow>('SELECT * FROM attachment_objects WHERE attachment_id=$1 AND id=$2 FOR UPDATE',[claim.attachmentId,claim.objectId])).rows[0];
  if(!a||!o||o.put_claim!==claim.claimId)return fail('CLAIM_CONFLICT');
  const expected=manifest(o);
  if(Object.entries(expected.locator).some(([k,v])=>observed.locator?.[k as keyof AttachmentObjectLocator]!==v)||observed.sizeBytes!==expected.sizeBytes||observed.sha256!==expected.sha256||!/^"[\x21\x23-\x7e]{1,254}"$/.test(observed.version))return fail('INTEGRITY');
  const eligible=Number(a.version)===claim.attachmentVersion&&a.lease_owner===claim.leaseOwner&&a.valid&&['UPLOADING','PENDING'].includes(a.state);
  if(o.put_settled_at){if(o.etag!==observed.version)return fail('INTEGRITY');return {acceptedForNextStep:eligible&&o.status==='WRITTEN'};}
  const accept=eligible&&Number(o.object_version)===claim.objectVersion&&o.status==='RESERVED';
  await client.query(`UPDATE attachment_objects SET etag=$2,put_settled_at=clock_timestamp(),put_uncertain=false,status=$3,object_version=object_version+1 WHERE id=$1`,[o.id,observed.version,accept?'WRITTEN':'DELETE_PENDING']);
  if(!accept)await client.query(`INSERT INTO attachment_cleanup_jobs(id,attachment_id,object_id,reason) VALUES(gen_random_uuid(),$1,$2,'LATE_WRITE') ON CONFLICT(object_id) WHERE completed_at IS NULL DO NOTHING`,[o.attachment_id,o.id]);
  return {acceptedForNextStep:accept};
 }
}
