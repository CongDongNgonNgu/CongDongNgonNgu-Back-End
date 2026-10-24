import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {transaction} from '../../study-groups/study-group.store';
import {ATTACHMENT_LIMITS as L} from '../attachment-policy';
import {AttachmentLifecycleLedger,AttachmentLifecycleError} from '../lifecycle/attachment-lifecycle-ledger';
import type {AttachmentCleanupIdentity,AttachmentCleanupClaim,AttachmentCleanupFailure} from '../attachment-cleanup-ledger';
import type {AttachmentCleanupRepository} from './attachment-cleanup-worker';
function bounded(limit:number):void{if(!Number.isInteger(limit)||limit<1||limit>L.cleanupBatch)throw Error('ATTACHMENT_CLEANUP_BATCH_INVALID');}
/** No provider operations and no production/config selection here. Caller supplies
 * the application's reviewed TEST pool. Every mutation rechecks ordinary system
 * domain order in a short transaction; unlocked candidate queries grant nothing. */
export class PostgresAttachmentCleanupRepository implements AttachmentCleanupRepository {
 constructor(private readonly pool:Pool,private readonly lifecycle=new AttachmentLifecycleLedger()){}
 async maintainMetadata(limit:number):Promise<number>{
  bounded(limit);
  const candidates=(await this.pool.query<{id:string;state:string}>(
   `SELECT a.id,a.state FROM attachments a WHERE
    (a.first_bound_at IS NULL AND a.state NOT IN ('DELETED','REJECTED') AND a.expires_at<=clock_timestamp())
    OR (a.state IN ('DELETED','REJECTED') AND a.physical_cleanup_at IS NULL AND NOT a.upload_slot_held AND NOT a.pending_slot_held AND a.lease_owner IS NULL
      AND NOT EXISTS(SELECT 1 FROM attachment_objects o WHERE o.attachment_id=a.id AND (o.status<>'DELETED' OR o.put_uncertain))
      AND NOT EXISTS(SELECT 1 FROM attachment_cleanup_jobs j WHERE j.attachment_id=a.id AND j.completed_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM attachment_processing_lease l WHERE l.attachment_id=a.id AND l.owner IS NOT NULL))
    ORDER BY a.created_at,a.id LIMIT $1`,[limit])).rows;
  for(const row of candidates){try{await transaction(this.pool,c=>['DELETED','REJECTED'].includes(row.state)?this.lifecycle.completePhysicalCleanup(c,row.id):this.lifecycle.expireDraft(c,row.id).then(()=>undefined));}catch(error){if(!(error instanceof AttachmentLifecycleError))throw error;}}
  // Charge selected candidates, including races, against this run's batch budget.
  return candidates.length;
 }
 async due(limit:number):Promise<AttachmentCleanupIdentity[]>{
  bounded(limit);return (await this.pool.query<{attachment_id:string;object_id:string;id:string}>(
   `SELECT j.attachment_id,j.object_id,j.id FROM attachment_cleanup_jobs j JOIN attachments a ON a.id=j.attachment_id JOIN attachment_objects o ON o.id=j.object_id AND o.attachment_id=a.id
    WHERE j.completed_at IS NULL AND j.attempts<$2 AND j.next_attempt_at<=clock_timestamp() AND (j.lease_owner IS NULL OR j.lease_expires_at<=clock_timestamp())
     AND NOT o.put_uncertain AND (o.put_claim IS NULL OR o.put_settled_at IS NOT NULL) AND o.status<>'DELETED'
     AND (a.state IN ('DELETED','REJECTED') OR (a.state='READY' AND o.variant='source' AND a.source_object_id=o.id))
    ORDER BY j.next_attempt_at,j.id LIMIT $1`,[limit,L.cleanupAttempts])).rows.map(r=>({attachmentId:r.attachment_id,objectId:r.object_id,jobId:r.id}));
 }
 claim(id:AttachmentCleanupIdentity):Promise<AttachmentCleanupClaim>{return transaction(this.pool,c=>this.lifecycle.claimCleanup(c,id,randomUUID()));}
 finish(claim:AttachmentCleanupClaim):Promise<void>{return transaction(this.pool,c=>this.lifecycle.finishCleanup(c,claim));}
 fail(claim:AttachmentCleanupClaim,code:AttachmentCleanupFailure):Promise<void>{return transaction(this.pool,c=>this.lifecycle.failCleanup(c,claim,code));}
}
