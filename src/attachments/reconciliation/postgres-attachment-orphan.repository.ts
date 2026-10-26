import type {Pool} from 'pg';
import {assertListedObjects,type AttachmentOrphanRepository,type ListedAttachmentObject,type OrphanClassification} from './attachment-orphan-detector';
interface Row {id:string;attachment_id:string;attempt_id:string;variant:string;byte_count:string;status:string;put_uncertain:boolean;put_claim:string|null;put_settled_at:Date|null;put_abandoned_at:Date|null;etag:string|null}
/** Read-only exact manifest observation. Never locks, mutates, returns raw keys,
 * performs domain authorization or grants a cleanup/reconciliation claim. */
export class PostgresAttachmentOrphanRepository implements AttachmentOrphanRepository {
 constructor(private readonly database:Pick<Pool,'query'>){}
 async classify(objects:readonly ListedAttachmentObject[]):Promise<readonly OrphanClassification[]>{
  assertListedObjects(objects);if(!objects.length)return [];
  const rows=(await this.database.query<Row>('SELECT id,attachment_id,attempt_id,variant,byte_count,status,put_uncertain,put_claim,put_settled_at,put_abandoned_at,etag FROM attachment_objects WHERE id=ANY($1::uuid[])',[objects.map(o=>o.locator.objectId)])).rows;
  const known=new Map(rows.map(row=>[row.id,row]));
  return objects.map(object=>{
   const row=known.get(object.locator.objectId);if(!row)return 'UNKNOWN_PRESENT';
   if(row.attachment_id!==object.locator.attachmentId||row.attempt_id!==object.locator.attemptId||row.variant!==object.locator.kind||Number(row.byte_count)!==object.sizeBytes)return 'OWNERSHIP_MISMATCH';
   if(row.put_abandoned_at)return 'INCONSISTENT_MANIFEST';
   if(row.put_uncertain||(row.put_claim&&!row.put_settled_at))return 'UNCERTAIN_PRESENT';
   if(row.status==='DELETED')return 'RETIRED_PRESENT';
   if(!row.put_claim)return 'UNCLAIMED_PRESENT';
   if(row.status==='DELETE_PENDING')return 'CLEANUP_PENDING';
   if(row.status==='WRITTEN'&&row.put_settled_at&&row.etag)return 'TRACKED';
   return 'INCONSISTENT_MANIFEST';
  });
 }
}

