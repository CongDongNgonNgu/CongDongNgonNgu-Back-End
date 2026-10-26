import {AttachmentQuotaLedger} from '../../src/attachments/attachment-quota-ledger';
import {AttachmentLifecycleLedger} from '../../src/attachments/lifecycle/attachment-lifecycle-ledger';
﻿import {randomUUID} from 'node:crypto';
import {readdir} from 'node:fs/promises';import path from 'node:path';
import {SqlHarness} from '../phase22/sql-harness';import {transaction,lockAccounts} from '../../src/study-groups/study-group.store';
import {AttachmentUploadLedger} from '../../src/attachments/upload/attachment-upload-ledger';
import {AttachmentObjectLedger} from '../../src/attachments/attachment-object-ledger';
import {patchDraftMetadata} from '../../src/attachments/initiation/attachment-draft-repository';

describe('Phase30 fenced upload reception',()=>{
 const lifecycle=new AttachmentLifecycleLedger();
 const db=new SqlHarness(),uploads=new AttachmentUploadLedger(),objects=new AttachmentObjectLedger();let actor:string,other:string,language:string;
 const tx=<T>(f:(c:import('pg').PoolClient)=>Promise<T>)=>transaction(db.pool,f);
 beforeAll(async()=>{await db.open();await db.migration('0027_phase22_study_groups.down.sql');const files=(await readdir(path.resolve(__dirname,'../../database/migrations'))).filter(f=>/^\d{4}_[\w-]+\.sql$/.test(f)&&Number(f.slice(0,4))>=2&&Number(f.slice(0,4))<=39).sort();for(const f of files)await db.migration(f);},180000);
 afterAll(async()=>db.close());
 beforeEach(async()=>{await db.reset();await db.pool.query('TRUNCATE attachment_quota_counters');actor=randomUUID();other=randomUUID();for(const id of [actor,other])await db.pool.query("INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at) VALUES($1,$2,$2,'Synthetic upload actor','ACTIVE',now())",[id,id+'@phase30.invalid']);language=(await db.pool.query("INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name) VALUES('en','english','English','English','English') ON CONFLICT(code) DO UPDATE SET active=true RETURNING id")).rows[0].id;});
 async function draft(expired=false){const id=randomUUID();await db.pool.query(`INSERT INTO attachments(id,uploader_id,scope,scope_id,language_id,community_post_type,community_visibility,client_upload_id,init_fingerprint,format,declared_mime,expected_bytes,display_filename,reserved_bytes,created_at,expires_at) VALUES($1,$2,'COMMUNITY',$3,$3,'DISCUSSION','PUBLIC',$4,$5,'TEXT','text/plain',3,'synthetic.txt',65539,CASE WHEN $6 THEN clock_timestamp()-interval '2 hours' ELSE clock_timestamp() END,CASE WHEN $6 THEN clock_timestamp()-interval '1 second' ELSE clock_timestamp()+interval '1 hour' END)`,[id,actor,language,randomUUID(),'a'.repeat(64),expired]);return id;}
 const bytes={sizeBytes:3,sha256:'b'.repeat(64)};
 async function received(id:string){const fence=await tx(c=>uploads.beginUpload(c,actor,id));const claim=await tx(c=>uploads.prepareSource(c,actor,fence,bytes));await tx(async c=>{await lockAccounts(c,[actor],true);return objects.recordPutResult(c,claim,{...claim.manifest,version:'"synthetic-etag"'});});return {fence,claim};}
 it('keeps an active byte-transfer fence valid across caption-only metadata edits',async()=>{const id=await draft(),fence=await tx(c=>uploads.beginUpload(c,actor,id));await tx(c=>patchDraftMetadata(c,actor,id,{expectedMetadataVersion:0,caption:'Synthetic edited caption',alt:''}));const claim=await tx(c=>uploads.prepareSource(c,actor,fence,bytes));await tx(async c=>{await lockAccounts(c,[actor],true);return objects.recordPutResult(c,claim,{...claim.manifest,version:'\"synthetic-etag\"'});});await expect(tx(c=>uploads.markPending(c,actor,fence,claim.objectId))).resolves.toEqual({state:'PENDING'});expect((await db.pool.query('SELECT metadata_version FROM attachments WHERE id=$1',[id])).rows[0].metadata_version).toBe('1');await expect(db.pool.query('UPDATE attachments SET metadata_version=metadata_version+1,lease_owner=$2,lease_expires_at=clock_timestamp()+interval \'1 minute\' WHERE id=$1',[id,randomUUID()])).rejects.toMatchObject({code:'23514'});});
 it('persists slot ownership through tombstone and transfers it once at PENDING',async()=>{const id=await draft();const {fence,claim}=await received(id);expect((await db.pool.query('SELECT upload_slot_held,pending_slot_held FROM attachments WHERE id=$1',[id])).rows[0]).toEqual({upload_slot_held:true,pending_slot_held:false});await tx(c=>uploads.markPending(c,actor,fence,claim.objectId));expect((await db.pool.query('SELECT upload_slot_held,pending_slot_held FROM attachments WHERE id=$1',[id])).rows[0]).toEqual({upload_slot_held:false,pending_slot_held:true});await db.pool.query("UPDATE attachments SET state='DELETED',deleted_at=clock_timestamp(),version=version+1 WHERE id=$1",[id]);expect((await db.pool.query('SELECT upload_slot_held,pending_slot_held FROM attachments WHERE id=$1',[id])).rows[0]).toEqual({upload_slot_held:false,pending_slot_held:true});});
 it('retains the exact selected source receipt after cleanup despite historical receipts',async()=>{
  const id=await draft(),oldObject=randomUUID();
  await db.pool.query(`INSERT INTO attachment_objects(id,attachment_id,attempt_id,variant,sha256,byte_count,content_type,status,put_claim,put_claimed_at,put_settled_at,etag,deleted_at) VALUES($1,$2,$3,'source',$4,3,'application/octet-stream','DELETED',$5,clock_timestamp(),clock_timestamp(),'"old-etag"',clock_timestamp())`,[oldObject,id,randomUUID(),'c'.repeat(64),randomUUID()]);
  const {fence,claim}=await received(id);await tx(c=>uploads.markPending(c,actor,fence,claim.objectId));
  expect((await db.pool.query('SELECT source_object_id FROM attachments WHERE id=$1',[id])).rows[0].source_object_id).toBe(claim.objectId);
  await db.pool.query("UPDATE attachments SET state='READY',version=version+1 WHERE id=$1",[id]);
  await db.pool.query("UPDATE attachment_objects SET status='DELETE_PENDING',object_version=object_version+1 WHERE id=$1",[claim.objectId]);
  await db.pool.query("UPDATE attachment_objects SET status='DELETED',deleted_at=clock_timestamp(),object_version=object_version+1 WHERE id=$1",[claim.objectId]);
  await expect(tx(c=>uploads.verifyCompletedSource(c,actor,id,bytes))).resolves.toEqual({state:'READY'});
  await expect(tx(c=>uploads.verifyCompletedSource(c,actor,id,{...bytes,sha256:'c'.repeat(64)}))).rejects.toThrow();
 });
 it('admits exactly one concurrent raw upload before any body intake',async()=>{const id=await draft();const results=await Promise.allSettled([tx(c=>uploads.beginUpload(c,actor,id)),tx(c=>uploads.beginUpload(c,actor,id))]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((await db.pool.query("SELECT sum(used)::int n FROM attachment_quota_counters WHERE action='upload'")).rows[0].n).toBe(2);});
 it('denies foreign users and expired drafts without consuming upload slots',async()=>{const id=await draft();await expect(tx(c=>uploads.beginUpload(c,other,id))).rejects.toThrow();const expiredId=await draft(true);await expect(tx(c=>uploads.beginUpload(c,actor,expiredId))).rejects.toThrow();expect((await db.pool.query('SELECT count(*)::int n FROM attachment_quota_counters')).rows[0].n).toBe(0);});
 it('persists exact ownership before a single-use source claim and never rewrites a consumed key',async()=>{const id=await draft(),fence=await tx(c=>uploads.beginUpload(c,actor,id));const results=await Promise.allSettled([tx(c=>uploads.prepareSource(c,actor,fence,bytes)),tx(c=>uploads.prepareSource(c,actor,fence,bytes))]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);const row=(await db.pool.query('SELECT * FROM attachment_objects WHERE attachment_id=$1',[id])).rows[0];expect(row).toMatchObject({variant:'source',sha256:bytes.sha256,put_uncertain:true});expect(row.put_claim).not.toBeNull();expect((await db.pool.query('SELECT count(*)::int n FROM attachment_objects WHERE attachment_id=$1',[id])).rows[0].n).toBe(1);});
 it('requires settled exact source bytes before atomically exchanging upload and pending slots',async()=>{const id=await draft(),fence=await tx(c=>uploads.beginUpload(c,actor,id));const claim=await tx(c=>uploads.prepareSource(c,actor,fence,bytes));await expect(tx(c=>uploads.markPending(c,actor,fence,claim.objectId))).rejects.toThrow();await tx(async c=>{await lockAccounts(c,[actor],true);return objects.recordPutResult(c,claim,{...claim.manifest,version:'"synthetic-etag"'});});await Promise.all([tx(c=>uploads.markPending(c,actor,fence,claim.objectId)),tx(c=>uploads.markPending(c,actor,fence,claim.objectId))]);const row=(await db.pool.query('SELECT state,lease_owner FROM attachments WHERE id=$1',[id])).rows[0];expect(row).toEqual({state:'PENDING',lease_owner:null});expect((await db.pool.query("SELECT action,sum(used)::int n FROM attachment_quota_counters GROUP BY action ORDER BY action")).rows).toEqual([{action:'pending',n:1},{action:'upload',n:0}]);await expect(tx(c=>uploads.verifyCompletedSource(c,actor,id,bytes))).resolves.toEqual({state:'PENDING'});await expect(tx(c=>uploads.verifyCompletedSource(c,actor,id,{...bytes,sha256:'c'.repeat(64)}))).rejects.toThrow();});
 it('does not revive a tombstone or release its upload debt on late completion',async()=>{const id=await draft(),{fence,claim}=await received(id);await db.pool.query("UPDATE attachments SET state='DELETED',deleted_at=clock_timestamp(),version=version+1 WHERE id=$1",[id]);await expect(tx(c=>uploads.markPending(c,actor,fence,claim.objectId))).rejects.toThrow();expect((await db.pool.query("SELECT sum(used)::int n FROM attachment_quota_counters WHERE action='upload'")).rows[0].n).toBe(2);});
 it('does not infer producer quiescence from an expired empty upload lease',async()=>{const id=await draft(),old=await tx(c=>uploads.beginUpload(c,actor,id));await db.pool.query("UPDATE attachments SET version=version+1,lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);await expect(tx(c=>uploads.beginUpload(c,actor,id))).rejects.toThrow('ATTACHMENT_UPLOAD_CONFLICT');expect((await db.pool.query('SELECT lease_owner,upload_slot_held FROM attachments WHERE id=$1',[id])).rows[0]).toEqual({lease_owner:old.leaseOwner,upload_slot_held:true});expect((await db.pool.query("SELECT sum(used)::int n FROM attachment_quota_counters WHERE action='upload'")).rows[0].n).toBe(2);await expect(tx(c=>uploads.prepareSource(c,actor,old,bytes))).rejects.toThrow();});
 it('holds uncertain old keys and rejects stale lease retries without allocating replacement objects',async()=>{const id=await draft(),fence=await tx(c=>uploads.beginUpload(c,actor,id));await tx(c=>uploads.prepareSource(c,actor,fence,bytes));await db.pool.query("UPDATE attachments SET version=version+1,lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);await expect(tx(c=>uploads.beginUpload(c,actor,id))).rejects.toThrow();expect((await db.pool.query('SELECT count(*)::int n FROM attachment_objects WHERE attachment_id=$1',[id])).rows[0].n).toBe(1);});
 it('rejects mismatched spooled bytes before allocating any physical key',async()=>{const id=await draft(),fence=await tx(c=>uploads.beginUpload(c,actor,id));for(const invalid of [{...bytes,sizeBytes:2},{...bytes,sha256:'not-a-checksum'}])await expect(tx(c=>uploads.prepareSource(c,actor,fence,invalid))).rejects.toThrow('ATTACHMENT_UPLOAD_INTEGRITY');expect((await db.pool.query('SELECT count(*)::int n FROM attachment_objects')).rows[0].n).toBe(0);});
 it('denies stale group drafts after leave and rejoin at pending promotion',async()=>{
  const group=await tx(async c=>{const id=(await c.query("INSERT INTO study_groups(name,owner_user_id) VALUES('Synthetic upload group',$1) RETURNING id",[other])).rows[0].id;
  await c.query("INSERT INTO study_group_memberships(group_id,user_id,role) VALUES($1,$2,'OWNER'),($1,$3,'MEMBER')",[id,other,actor]);return id;});
  const generation=(await db.pool.query('SELECT generation FROM study_group_memberships WHERE group_id=$1 AND user_id=$2',[group,actor])).rows[0].generation;
  const id=randomUUID();await db.pool.query(`INSERT INTO attachments(id,uploader_id,scope,scope_id,group_id,scope_generation,client_upload_id,init_fingerprint,format,declared_mime,expected_bytes,display_filename,reserved_bytes,expires_at) VALUES($1,$2,'STUDY_GROUP',$3,$3,$4,$5,$6,'TEXT','text/plain',3,'synthetic.txt',65539,clock_timestamp()+interval '1 hour')`,[id,actor,group,generation,randomUUID(),'a'.repeat(64)]);
  const {fence,claim}=await received(id);
  await db.pool.query("UPDATE study_group_memberships SET status='LEFT' WHERE group_id=$1 AND user_id=$2",[group,actor]);
  await db.pool.query("UPDATE study_group_memberships SET status='ACTIVE' WHERE group_id=$1 AND user_id=$2",[group,actor]);
  await expect(tx(c=>uploads.markPending(c,actor,fence,claim.objectId))).rejects.toMatchObject({code:'ATTACHMENT_UNAVAILABLE'});
  expect((await db.pool.query("SELECT state FROM attachments WHERE id=$1",[id])).rows[0].state).toBe('UPLOADING');
 });
 it('rechecks current actor authorization at source claim and pending promotion',async()=>{const id=await draft(),fence=await tx(c=>uploads.beginUpload(c,actor,id));await db.pool.query("UPDATE users SET status='DISABLED' WHERE id=$1",[actor]);await expect(tx(c=>uploads.prepareSource(c,actor,fence,bytes))).rejects.toThrow();expect((await db.pool.query('SELECT count(*)::int n FROM attachment_objects')).rows[0].n).toBe(0);});

 async function completed(){const id=await draft(),{fence,claim}=await received(id);await tx(c=>uploads.markPending(c,actor,fence,claim.objectId));return {id,sourceId:claim.objectId};}
 it('admits one completed-body replay, denies expired-lease takeover, and changes neither state nor objects',async()=>{
  const {id}=await completed(),before=(await db.pool.query('SELECT state,version,lease_owner FROM attachments WHERE id=$1',[id])).rows[0];
  const outcomes=await Promise.allSettled([tx(c=>uploads.beginReplay(c,actor,id)),tx(c=>uploads.beginReplay(c,actor,id))]);expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const replay=(outcomes.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<AttachmentUploadLedger['beginReplay']>>>).value;
  await db.pool.query("UPDATE attachment_upload_replay_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE attachment_id=$1",[id]);await expect(tx(c=>uploads.beginReplay(c,actor,id))).rejects.toThrow();
  await expect(tx(c=>uploads.verifyCompletedSource(c,actor,id,bytes))).resolves.toEqual({state:'PENDING'});
  expect((await db.pool.query('SELECT state,version,lease_owner FROM attachments WHERE id=$1',[id])).rows[0]).toEqual(before);expect((await db.pool.query('SELECT count(*)::int n FROM attachment_objects WHERE attachment_id=$1',[id])).rows[0].n).toBe(1);
  await tx(c=>lifecycle.settleReplay(c,{...replay,producerQuiesced:true}));expect((await db.pool.query("SELECT sum(used)::int n FROM attachment_quota_counters WHERE action='upload'")).rows[0].n).toBe(0);
 });
 it('releases replay intake only on exact quiesced ownership and stale owners cannot release a newer intake',async()=>{
  const {id}=await completed(),first=await tx(c=>uploads.beginReplay(c,actor,id));
  await expect(tx(c=>lifecycle.settleReplay(c,{...first,owner:randomUUID(),producerQuiesced:true}))).rejects.toThrow();
  await expect(tx(c=>lifecycle.settleReplay(c,{...first,producerQuiesced:false} as never))).rejects.toThrow();
  await tx(c=>lifecycle.settleReplay(c,{...first,producerQuiesced:true}));const second=await tx(c=>uploads.beginReplay(c,actor,id));
  await expect(tx(c=>lifecycle.settleReplay(c,{...first,producerQuiesced:true}))).rejects.toThrow();
  expect((await db.pool.query('SELECT owner FROM attachment_upload_replay_leases WHERE attachment_id=$1',[id])).rows[0].owner).toBe(second.owner);
  await tx(c=>lifecycle.settleReplay(c,{...second,producerQuiesced:true}));
 });
 it('retains the replay fence through delete/revocation and permits only internal quiesced settlement without access grants',async()=>{
  const {id}=await completed(),replay=await tx(c=>uploads.beginReplay(c,actor,id));await tx(c=>lifecycle.deleteOwned(c,actor,id));await db.pool.query("UPDATE users SET status='DISABLED' WHERE id=$1",[actor]);
  await expect(tx(c=>uploads.verifyCompletedSource(c,actor,id,bytes))).rejects.toThrow();await expect(tx(c=>lifecycle.completePhysicalCleanup(c,id))).rejects.toThrow();
  // Remove every other cleanup blocker: the replay fence alone must still forbid
  // physical completion and reservation release until actual intake quiescence.
  await db.pool.query("UPDATE attachment_objects SET status='DELETED',deleted_at=clock_timestamp(),object_version=object_version+1 WHERE attachment_id=$1",[id]);
  await db.pool.query('UPDATE attachment_cleanup_jobs SET completed_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL WHERE attachment_id=$1',[id]);
  await expect(tx(c=>lifecycle.completePhysicalCleanup(c,id))).rejects.toThrow();
  await expect(db.pool.query('UPDATE attachments SET physical_cleanup_at=clock_timestamp(),version=version+1 WHERE id=$1',[id])).rejects.toMatchObject({code:'23514'});
  expect((await db.pool.query('SELECT owner FROM attachment_upload_replay_leases WHERE attachment_id=$1',[id])).rows[0].owner).toBe(replay.owner);
  await tx(c=>lifecycle.settleReplay(c,{...replay,producerQuiesced:true}));expect((await db.pool.query('SELECT count(*)::int n FROM attachment_upload_replay_leases')).rows[0].n).toBe(0);expect((await db.pool.query("SELECT sum(used)::int n FROM attachment_quota_counters WHERE action='upload'")).rows[0].n).toBe(0);
 });
 it('holds completed-body upload concurrency independently while processing is active and rejects byte conflicts',async()=>{
  const {id}=await completed(),processingOwner=randomUUID();await db.pool.query("UPDATE attachments SET lease_owner=$2,lease_expires_at=clock_timestamp()+interval '2 minutes',version=version+1 WHERE id=$1",[id,processingOwner]);
  const replay=await tx(c=>uploads.beginReplay(c,actor,id));await expect(tx(c=>uploads.verifyCompletedSource(c,actor,id,{...bytes,sha256:'f'.repeat(64)}))).rejects.toThrow('ATTACHMENT_UPLOAD_INTEGRITY');
  expect((await db.pool.query('SELECT lease_owner FROM attachments WHERE id=$1',[id])).rows[0].lease_owner).toBe(processingOwner);
  const otherDraft=await draft();await expect(tx(c=>uploads.beginUpload(c,actor,otherDraft))).rejects.toThrow();
  await tx(c=>lifecycle.settleReplay(c,{...replay,producerQuiesced:true}));expect((await db.pool.query('SELECT lease_owner FROM attachments WHERE id=$1',[id])).rows[0].lease_owner).toBe(processingOwner);
 });
 it('requires fresh ownership and a selected settled source receipt before replay admission',async()=>{
  const {id,sourceId}=await completed();await expect(tx(c=>uploads.beginReplay(c,other,id))).rejects.toThrow();await db.pool.query("UPDATE attachment_objects SET status='DELETE_PENDING',object_version=object_version+1 WHERE id=$1",[sourceId]);await db.pool.query("UPDATE attachment_objects SET status='DELETED',deleted_at=clock_timestamp(),object_version=object_version+1 WHERE id=$1",[sourceId]);
  const replay=await tx(c=>uploads.beginReplay(c,actor,id));await expect(tx(c=>uploads.verifyCompletedSource(c,actor,id,bytes))).resolves.toEqual({state:'PENDING'});await tx(c=>lifecycle.settleReplay(c,{...replay,producerQuiesced:true}));
  const draftId=await draft();await expect(tx(c=>uploads.beginReplay(c,actor,draftId))).rejects.toThrow();
 });


 it('settles admitted replay intake after binding without reopening draft access or altering permanent binding',async()=>{
  const {id}=await completed();await tx(async c=>{await new AttachmentQuotaLedger().changeCapacity(c,actor,{pendingDelta:-1});await c.query("UPDATE attachments SET state='READY',pending_slot_held=false,version=version+1 WHERE id=$1",[id]);});
  const replay=await tx(c=>uploads.beginReplay(c,actor,id)),post=randomUUID();
  await tx(async c=>{await c.query("INSERT INTO community_posts(id,author_user_id,target_language_id,post_type,content,visibility) VALUES($1,$2,$3,'DISCUSSION','Synthetic replay binding','PUBLIC')",[post,actor,language]);await c.query("INSERT INTO attachment_bindings(attachment_id,uploader_id,scope,scope_id,community_post_id,position) VALUES($1,$2,'COMMUNITY',$3,$4,0)",[id,actor,language,post]);});
  const binding=(await db.pool.query('SELECT first_bound_at FROM attachments WHERE id=$1',[id])).rows[0].first_bound_at;
  await expect(tx(c=>uploads.verifyCompletedSource(c,actor,id,bytes))).rejects.toThrow();
  await tx(c=>lifecycle.settleReplay(c,{...replay,producerQuiesced:true}));expect((await db.pool.query('SELECT first_bound_at FROM attachments WHERE id=$1',[id])).rows[0].first_bound_at).toEqual(binding);expect((await db.pool.query('SELECT count(*)::int n FROM attachment_upload_replay_leases')).rows[0].n).toBe(0);
 });

});
