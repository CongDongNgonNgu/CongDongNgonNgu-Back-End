import {AttachmentObjectLedger} from '../../src/attachments/attachment-object-ledger';
import {transaction,lockAccounts} from '../../src/study-groups/study-group.store';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {SqlHarness} from '../phase22/sql-harness';

describe('Phase30 isolated PostgreSQL attachment constraints',()=>{
 const db=new SqlHarness(); let actor:string, language:string;
 beforeAll(async()=>{
  await readFile(path.resolve(__dirname,'../../database/migrations/0039_phase30_attachments.sql'),'utf8');
  await db.open(); await db.migration('0027_phase22_study_groups.down.sql');
  const files=(await readdir(path.resolve(__dirname,'../../database/migrations'))).filter(f=>/^\d{4}_[\w-]+\.sql$/.test(f)&&Number(f.slice(0,4))>=2&&Number(f.slice(0,4))<=39).sort();
  for(const file of files) await db.migration(file);
 },180000);
 afterAll(async()=>{await db.close();});
 beforeEach(async()=>{
  await db.reset();await db.pool.query('INSERT INTO attachment_processing_lease(singleton) VALUES(true) ON CONFLICT DO NOTHING');actor=randomUUID();
  await db.pool.query("INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at) VALUES($1,$2,$2,'Synthetic attachment actor','ACTIVE',now())",[actor,actor+'@phase30.invalid']);
  language=(await db.pool.query("INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name) VALUES('en','english','English','English','English') ON CONFLICT(code) DO UPDATE SET active=true RETURNING id")).rows[0].id;
 });
 async function draft(clientId=randomUUID()) {
  const id=randomUUID();
  await db.pool.query(`INSERT INTO attachments(id,uploader_id,scope,scope_id,language_id,community_post_type,community_visibility,client_upload_id,init_fingerprint,format,declared_mime,expected_bytes,display_filename,reserved_bytes,expires_at)
   VALUES($1,$2,'COMMUNITY',$3,$3,'DISCUSSION','PUBLIC',$4,$5,'IMAGE','image/png',20,'synthetic.png',4456468,clock_timestamp()+interval '1 hour')`,[id,actor,language,clientId,'a'.repeat(64)]);
  return id;
 }
 it('enforces immutable initiation and exact idempotency uniqueness',async()=>{
  const key=randomUUID(),id=await draft(key);
  await expect(draft(key)).rejects.toMatchObject({code:'23505'});
  await expect(db.pool.query('UPDATE attachments SET expected_bytes=21,version=version+1 WHERE id=$1',[id])).rejects.toMatchObject({code:'23514'});
 });
 it('prevents skipped transitions and terminal resurrection',async()=>{
  const id=await draft();
  await expect(db.pool.query("UPDATE attachments SET state='READY',version=version+1 WHERE id=$1",[id])).rejects.toMatchObject({code:'23514'});
  await db.pool.query("UPDATE attachments SET state='DELETED',deleted_at=clock_timestamp(),version=version+1 WHERE id=$1",[id]);
  await expect(db.pool.query("UPDATE attachments SET state='UPLOADING',version=version+1 WHERE id=$1",[id])).rejects.toMatchObject({code:'23514'});
 });
 it('rejects upload state without durable version/lease ownership',async()=>{
  const id=await draft();
  await expect(db.pool.query("UPDATE attachments SET state='UPLOADING',version=version+1 WHERE id=$1",[id])).rejects.toMatchObject({code:'23514'});
 });
 it('blocks account hard deletion while cleanup ownership remains',async()=>{
  await draft();
  await expect(db.pool.query('DELETE FROM users WHERE id=$1',[actor])).rejects.toMatchObject({code:'23001'});
 });
 it('keeps immutable storage ownership and forbids premature manifest purge',async()=>{
  const id=await draft(),object=randomUUID();
  await db.pool.query("INSERT INTO attachment_objects(id,attachment_id,attempt_id,variant,sha256,byte_count,content_type) VALUES($1,$2,$3,'source',$4,20,'application/octet-stream')",[object,id,randomUUID(),'b'.repeat(64)]);
  await expect(db.pool.query('UPDATE attachment_objects SET attempt_id=$1 WHERE id=$2',[randomUUID(),object])).rejects.toMatchObject({code:'23514'});
  await expect(db.pool.query('DELETE FROM attachment_objects WHERE id=$1',[object])).rejects.toMatchObject({code:'23514'});
 });
 it('cannot point an attachment cleanup job at another attachments object',async()=>{
  const a=await draft(),b=await draft(),object=randomUUID();
  await db.pool.query("INSERT INTO attachment_objects(id,attachment_id,attempt_id,variant,sha256,byte_count,content_type) VALUES($1,$2,$3,'source',$4,20,'application/octet-stream')",[object,b,randomUUID(),'c'.repeat(64)]);
  await expect(db.pool.query("INSERT INTO attachment_cleanup_jobs(id,attachment_id,object_id,reason) VALUES($1,$2,$3,'REJECTED')",[randomUUID(),a,object])).rejects.toMatchObject({code:'23503'});
 });
 async function producerFixture() {
  const id=await draft(),lease=randomUUID(),object=randomUUID(),attempt=randomUUID();
  await db.pool.query("UPDATE attachments SET state='UPLOADING',lease_owner=$2,lease_expires_at=clock_timestamp()+interval '1 minute',version=version+1 WHERE id=$1",[id,lease]);
  await db.pool.query("INSERT INTO attachment_objects(id,attachment_id,attempt_id,variant,sha256,byte_count,content_type) VALUES($1,$2,$3,'source',$4,20,'application/octet-stream')",[object,id,attempt,'d'.repeat(64)]);
  return {id,lease,object,attempt};
 }
 const ledger=new AttachmentObjectLedger();
 async function claim(f:{id:string;lease:string;object:string},version=1) {
  return transaction(db.pool,async client=>{await lockAccounts(client,[actor],false);return ledger.claimPut(client,f.id,f.object,{attachmentVersion:version,leaseOwner:f.lease},randomUUID());});
 }
 it('consumes a physical key once even with concurrent producers',async()=>{
  const f=await producerFixture();const results=await Promise.allSettled([claim(f),claim(f)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  const row=(await db.pool.query('SELECT put_claim,put_uncertain FROM attachment_objects WHERE id=$1',[f.object])).rows[0];
  expect(row.put_claim).toBeTruthy();expect(row.put_uncertain).toBe(true);
 });
 it('never grants a consumed key to an expired-lease successor',async()=>{
  const f=await producerFixture();await claim(f);
  const newer=randomUUID();await db.pool.query('UPDATE attachments SET lease_owner=$2,version=version+1 WHERE id=$1',[f.id,newer]);
  await expect(claim({...f,lease:newer},2)).rejects.toThrow('ATTACHMENT_OBJECT_CLAIM_CONFLICT');
 });
 it('records late completed PUT as cleanup debt without reviving a tombstone',async()=>{
  const f=await producerFixture(),c=await claim(f);
  await db.pool.query("UPDATE attachments SET state='DELETED',deleted_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,version=version+1 WHERE id=$1",[f.id]);
  const result=await transaction(db.pool,client=>ledger.recordPutResult(client,c,{locator:{attachmentId:f.id,attemptId:f.attempt,objectId:f.object,kind:'source'},sizeBytes:20,sha256:'d'.repeat(64),version:'"synthetic-etag"'}));
  expect(result.acceptedForNextStep).toBe(false);
  const object=(await db.pool.query('SELECT status,put_uncertain FROM attachment_objects WHERE id=$1',[f.object])).rows[0];
  expect(object).toEqual({status:'DELETE_PENDING',put_uncertain:false});
  expect((await db.pool.query("SELECT count(*)::int n FROM attachment_cleanup_jobs WHERE object_id=$1 AND reason='LATE_WRITE' AND completed_at IS NULL",[f.object])).rows[0].n).toBe(1);
  expect((await db.pool.query('SELECT state FROM attachments WHERE id=$1',[f.id])).rows[0].state).toBe('DELETED');
 });
 it('cannot declare physical cleanup while a PUT remains uncertain',async()=>{
  const f=await producerFixture();await claim(f);
  await db.pool.query("UPDATE attachments SET state='DELETED',deleted_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,version=version+1 WHERE id=$1",[f.id]);
  await expect(db.pool.query('UPDATE attachments SET physical_cleanup_at=clock_timestamp(),version=version+1 WHERE id=$1',[f.id])).rejects.toMatchObject({code:'23514'});
 });
 it('cannot erase uncertain debt or record deletion before the consumed PUT settles',async()=>{
  const f=await producerFixture();await claim(f);
  await expect(db.pool.query('UPDATE attachment_objects SET put_uncertain=false,object_version=object_version+1 WHERE id=$1',[f.object])).rejects.toMatchObject({code:'23514'});
  await db.pool.query("UPDATE attachment_objects SET status='DELETE_PENDING',object_version=object_version+1 WHERE id=$1",[f.object]);
  await expect(db.pool.query("UPDATE attachment_objects SET status='DELETED',deleted_at=clock_timestamp(),object_version=object_version+1 WHERE id=$1",[f.object])).rejects.toMatchObject({code:'23514'});
 });
 it('keeps a duplicate settled acknowledgement inert after recorded object cleanup',async()=>{
  const f=await producerFixture(),c=await claim(f);
  const observed={locator:{attachmentId:f.id,attemptId:f.attempt,objectId:f.object,kind:'source' as const},sizeBytes:20,sha256:'d'.repeat(64),version:'"synthetic-etag"'};
  expect((await transaction(db.pool,client=>ledger.recordPutResult(client,c,observed))).acceptedForNextStep).toBe(true);
  await db.pool.query("UPDATE attachment_objects SET status='DELETE_PENDING',object_version=object_version+1 WHERE id=$1",[f.object]);
  await db.pool.query("UPDATE attachment_objects SET status='DELETED',deleted_at=clock_timestamp(),object_version=object_version+1 WHERE id=$1",[f.object]);
  await db.pool.query("UPDATE attachments SET state='DELETED',deleted_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL,version=version+1 WHERE id=$1",[f.id]);
  await db.pool.query('UPDATE attachments SET physical_cleanup_at=clock_timestamp(),version=version+1 WHERE id=$1',[f.id]);
  expect((await transaction(db.pool,client=>ledger.recordPutResult(client,c,observed))).acceptedForNextStep).toBe(false);
  expect((await db.pool.query('SELECT status FROM attachment_objects WHERE id=$1',[f.object])).rows[0].status).toBe('DELETED');
  expect((await db.pool.query('SELECT physical_cleanup_at FROM attachments WHERE id=$1',[f.id])).rows[0].physical_cleanup_at).not.toBeNull();
  expect((await db.pool.query('SELECT count(*)::int n FROM attachment_cleanup_jobs WHERE object_id=$1',[f.object])).rows[0].n).toBe(0);
 });
 it('enforces atomic singleton processing exclusion',async()=>{
  const a=randomUUID(),b=randomUUID();
  const results=await Promise.all([a,b].map(owner=>db.pool.query("UPDATE attachment_processing_lease SET owner=$1,expires_at=clock_timestamp()+interval '2 minutes' WHERE singleton AND (owner IS NULL OR expires_at<=clock_timestamp()) RETURNING owner",[owner])));
  expect(results.reduce((n,r)=>n+r.rowCount!,0)).toBe(1);
  await db.pool.query('UPDATE attachment_processing_lease SET owner=NULL,expires_at=NULL WHERE singleton');
 });
 it('reserves quota atomically without negative or over-limit counters',async()=>{
  await db.pool.query("INSERT INTO attachment_quota_counters(kind,subject,action,window_start,used,ceiling) VALUES('DEPLOYMENT','test','bytes','epoch',250,256)");
  const results=await Promise.all([1,2,3].map(()=>db.pool.query("UPDATE attachment_quota_counters SET used=used+4 WHERE kind='DEPLOYMENT' AND subject='test' AND action='bytes' AND window_start='epoch' AND used+4<=ceiling RETURNING used")));
  expect(results.reduce((n,r)=>n+r.rowCount!,0)).toBe(1);
  await expect(db.pool.query("UPDATE attachment_quota_counters SET used=-1")).rejects.toMatchObject({code:'23514'});
  await db.pool.query('DELETE FROM attachment_quota_counters');
 });
 it('keeps metadata CAS independent without allowing state or lease changes through its exception',async()=>{
  const id=await draft();await db.pool.query("UPDATE attachments SET caption='Synthetic caption',metadata_version=metadata_version+1 WHERE id=$1",[id]);
  expect((await db.pool.query('SELECT version,metadata_version FROM attachments WHERE id=$1',[id])).rows[0]).toEqual({version:'0',metadata_version:'1'});
  await expect(db.pool.query("UPDATE attachments SET caption='other',metadata_version=metadata_version+1,state='UPLOADING',lease_owner=$2,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1",[id,randomUUID()])).rejects.toMatchObject({code:'23514'});
  await db.pool.query("UPDATE attachments SET state='DELETED',deleted_at=clock_timestamp(),version=version+1 WHERE id=$1",[id]);
  await expect(db.pool.query("UPDATE attachments SET caption='afterdelete',metadata_version=metadata_version+1 WHERE id=$1",[id])).rejects.toMatchObject({code:'23514'});
 });
 it('round-trips the additive migration only in its disposable schema while preserving baseline users',async()=>{
  const before=(await db.pool.query('SELECT count(*)::int n FROM users')).rows[0].n;
  await db.migration('0039_phase30_attachments.down.sql');
  expect((await db.pool.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE 'attachment%'")).rows[0].n).toBe(0);
  expect((await db.pool.query('SELECT count(*)::int n FROM users')).rows[0].n).toBe(before);
  await db.migration('0039_phase30_attachments.sql');
  expect((await db.pool.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE 'attachment%'")).rows[0].n).toBe(7);
  expect((await db.pool.query('SELECT count(*)::int n FROM users')).rows[0].n).toBe(before);
 });

});
