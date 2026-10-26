import type {Pool} from 'pg';
import {transaction} from '../../study-groups/study-group.store';
import {ATTACHMENT_LIMITS as L} from '../attachment-policy';
import {AttachmentLifecycleLedger} from '../lifecycle/attachment-lifecycle-ledger';
export class AttachmentTerminalPurgeError extends Error{constructor(){super('ATTACHMENT_TERMINAL_PURGE_INVALID');this.name='AttachmentTerminalPurgeError';}}
const invalid=():never=>{throw new AttachmentTerminalPurgeError();};
export interface TerminalPurgeResult{status:'PURGED'|'INELIGIBLE'|'SKIPPED_BUDGET';used:number;required:number;}
const constraints='phase30_source_identity,phase30_normalized_identity,phase30_thumbnail_identity';
/** Internal atomic terminal graph retention. Separate from rate-only retention.
 * No provider I/O, quota changes, trigger bypass, key clearing or parent cascade.
 * The complete exact graph counts against the caller's shared awake batch budget.
 */
export class AttachmentTerminalPurge {
 constructor(private readonly pool:Pool,private readonly lifecycle=new AttachmentLifecycleLedger()){}
 async purgeOne(id:string,budget:number=L.cleanupBatch):Promise<TerminalPurgeResult>{
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)||!Number.isSafeInteger(budget)||budget<1||budget>L.cleanupBatch)return invalid();
  return transaction(this.pool,async c=>{
   if(!(await c.query('SELECT 1 FROM attachments WHERE id=$1',[id])).rowCount)return {status:'INELIGIBLE',used:0,required:0};
   await this.lifecycle.lockForTerminalRetention(c,id);
   const objects=(await c.query<{id:string}>('SELECT id FROM attachment_objects WHERE attachment_id=$1 ORDER BY id LIMIT $2 FOR UPDATE',[id,budget+1])).rows;
   const jobs=(await c.query<{id:string}>('SELECT id FROM attachment_cleanup_jobs WHERE attachment_id=$1 ORDER BY id LIMIT $2 FOR UPDATE',[id,budget+1])).rows;
   const bindings=(await c.query<{attachment_id:string}>('SELECT attachment_id FROM attachment_bindings WHERE attachment_id=$1 FOR UPDATE',[id])).rows;
   const admissions=(await c.query<{attachment_id:string}>('SELECT attachment_id FROM attachment_initiation_admissions WHERE attachment_id=$1 ORDER BY uploader_id,client_upload_id FOR UPDATE',[id])).rows;
   // Singleton is last. Even a stale null-owner reference is retained, not erased.
   if((await c.query('SELECT singleton FROM attachment_processing_lease WHERE singleton FOR UPDATE')).rowCount!==1)return {status:'INELIGIBLE',used:0,required:0};
   const required=1+objects.length+jobs.length+bindings.length+admissions.length;
   if(required>budget)return {status:'SKIPPED_BUDGET',used:0,required};
   if(!(await c.query<{eligible:boolean}>('SELECT phase30_terminal_purge_eligible($1) AS eligible',[id])).rows[0]?.eligible)return {status:'INELIGIBLE',used:0,required};
   await c.query('SET CONSTRAINTS '+constraints+' DEFERRED');
   let used=0;
   for(const [table,expected] of [['attachment_cleanup_jobs',jobs.length],['attachment_bindings',bindings.length],['attachment_initiation_admissions',admissions.length],['attachment_objects',objects.length],['attachments',1]] as const){
    const deleted=await c.query('DELETE FROM '+table+' WHERE '+(table==='attachments'?'id':'attachment_id')+'=$1',[id]);
    if(deleted.rowCount!==expected)return invalid();used+=deleted.rowCount;
   }
   if(used!==required)return invalid();await c.query('SET CONSTRAINTS '+constraints+' IMMEDIATE');
   return {status:'PURGED',used,required};
  });
 }
}
