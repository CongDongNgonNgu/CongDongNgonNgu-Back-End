import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {transaction} from '../../study-groups/study-group.store';
import {ATTACHMENT_LIMITS as L} from '../attachment-policy';
import {AttachmentLifecycleLedger,AttachmentLifecycleError} from '../lifecycle/attachment-lifecycle-ledger';
import type {AttachmentCleanupIdentity,AttachmentCleanupClaim,AttachmentCleanupFailure} from '../attachment-cleanup-ledger';
import type {AttachmentCleanupRepository} from './attachment-cleanup-worker';
import {AttachmentRetentionLedger} from '../retention/attachment-retention-ledger';
import {AttachmentTerminalPurge,type TerminalPurgeResult} from '../retention/attachment-terminal-purge';
function bounded(limit:number):void{if(!Number.isInteger(limit)||limit<1||limit>L.cleanupBatch)throw Error('ATTACHMENT_CLEANUP_BATCH_INVALID');}
/** No provider operations and no production/config selection here. Caller supplies
 * the application's reviewed TEST pool. Every mutation rechecks ordinary system
 * domain order in a short transaction; unlocked candidate queries grant nothing. */
export class PostgresAttachmentCleanupRepository implements AttachmentCleanupRepository {
 private terminalCursor:string|null=null;
 constructor(private readonly pool:Pool,private readonly lifecycle=new AttachmentLifecycleLedger(),private readonly retention=new AttachmentRetentionLedger(),private readonly terminals=new AttachmentTerminalPurge(pool,lifecycle)){}
 /** Read-only candidate scan grants no deletion authority. Each complete graph
  * has its own ordered transaction and counts actual rows against this tick.
  * A skipped graph advances the cursor; an infrastructure failure does not. */
 async purgeTerminals(limit:number,canContinue:()=>boolean=()=>true):Promise<number>{
  bounded(limit);if(!canContinue())return 0;
  const candidates=(await this.pool.query<{id:string}>(
   `SELECT id FROM attachments WHERE state='DELETED' AND physical_cleanup_at<=clock_timestamp()-interval '7 days'
    AND ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT $2`,[this.terminalCursor,L.cleanupBatch])).rows;
  if(candidates.length>L.cleanupBatch)throw Error('ATTACHMENT_CLEANUP_BATCH_INVALID');
  if(!candidates.length){this.terminalCursor=null;return 0;}
  let used=0,previous=this.terminalCursor;
  for(const {id} of candidates){
   if(!canContinue()||used===limit)break;
   if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)||(previous!==null&&id<=previous))throw Error('ATTACHMENT_CLEANUP_BATCH_INVALID');
   const remaining=limit-used;let result:TerminalPurgeResult;
   try{result=await this.terminals.purgeOne(id,remaining);}
   catch(error){if(error instanceof AttachmentLifecycleError){this.terminalCursor=id;previous=id;continue;}throw error;}
   if(!result||!Number.isSafeInteger(result.used)||result.used<0||result.used>remaining||!Number.isSafeInteger(result.required)||result.required<0
    ||(result.status==='PURGED'?(result.used<1||result.used!==result.required):result.used!==0)
    ||!['PURGED','INELIGIBLE','SKIPPED_BUDGET'].includes(result.status)
    ||(result.status==='SKIPPED_BUDGET'&&result.required<=remaining))throw Error('ATTACHMENT_CLEANUP_BATCH_INVALID');
   used+=result.used;this.terminalCursor=id;previous=id;
  }
  return used;
 }
 /** Dedicated rate-only transaction. No domain locks are retained or acquired
  * after retention's admission/counter locks; commit completes before returning. */
 async purgeRetention(limit:number):Promise<number>{
  bounded(limit);return transaction(this.pool,async client=>(await this.retention.purge(client,limit)).used);
 }
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
     AND NOT o.put_uncertain AND (o.put_claim IS NULL OR o.put_settled_at IS NOT NULL OR o.put_abandoned_at IS NOT NULL) AND o.status<>'DELETED'
     AND (a.state IN ('DELETED','REJECTED') OR (a.state='READY' AND o.variant='source' AND a.source_object_id=o.id))
    ORDER BY j.next_attempt_at,j.id LIMIT $1`,[limit,L.cleanupAttempts])).rows.map(r=>({attachmentId:r.attachment_id,objectId:r.object_id,jobId:r.id}));
 }
 claim(id:AttachmentCleanupIdentity):Promise<AttachmentCleanupClaim>{return transaction(this.pool,c=>this.lifecycle.claimCleanup(c,id,randomUUID()));}
 finish(claim:AttachmentCleanupClaim):Promise<void>{return transaction(this.pool,c=>this.lifecycle.finishCleanup(c,claim));}
 fail(claim:AttachmentCleanupClaim,code:AttachmentCleanupFailure):Promise<void>{return transaction(this.pool,c=>this.lifecycle.failCleanup(c,claim,code));}
}
