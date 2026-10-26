import {randomUUID} from 'node:crypto';import {readdir} from 'node:fs/promises';import path from 'node:path';
import {SqlHarness} from '../phase22/sql-harness';import {transaction} from '../../src/study-groups/study-group.store';
import {PostgresAttachmentOrphanRepository} from '../../src/attachments/reconciliation/postgres-attachment-orphan.repository';
import {AttachmentOrphanDetector,type ListedAttachmentObject} from '../../src/attachments/reconciliation/attachment-orphan-detector';
describe('Phase30 read-only bounded orphan observations',()=>{
 const db=new SqlHarness();let actor:string,language:string;
 beforeAll(async()=>{await db.open();await db.migration('0027_phase22_study_groups.down.sql');const files=(await readdir(path.resolve(__dirname,'../../database/migrations'))).filter(f=>/^\d{4}_[\w-]+\.sql$/.test(f)&&Number(f.slice(0,4))>=2&&Number(f.slice(0,4))<=39).sort();for(const file of files)await db.migration(file);},180000);
 afterAll(async()=>db.close());
 beforeEach(async()=>{await db.reset();actor=randomUUID();await db.pool.query("INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at) VALUES($1,$2,$2,'Synthetic orphan observer','ACTIVE',now())",[actor,actor+'@phase30.invalid']);language=(await db.pool.query("INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name) VALUES('en','english','English','English','English') ON CONFLICT(code) DO UPDATE SET active=true RETURNING id")).rows[0].id;});
 async function attachment(){const id=randomUUID();await db.pool.query(`INSERT INTO attachments(id,uploader_id,scope,scope_id,language_id,community_post_type,community_visibility,client_upload_id,init_fingerprint,format,declared_mime,expected_bytes,display_filename,reserved_bytes,expires_at) VALUES($1,$2,'COMMUNITY',$3,$3,'DISCUSSION','PRIVATE',$4,$5,'IMAGE','image/png',20,'synthetic.png',4456468,clock_timestamp()+interval '1 hour')`,[id,actor,language,randomUUID(),'a'.repeat(64)]);return id;}
 async function object(state:'WRITTEN'|'DELETE_PENDING'|'DELETED'|'UNCERTAIN'|'UNCLAIMED'|'INCONSISTENT'):Promise<ListedAttachmentObject>{
  const attachmentId=await attachment(),objectId=randomUUID(),attemptId=randomUUID(),uncertain=state==='UNCERTAIN',unclaimed=state==='UNCLAIMED',status=uncertain||unclaimed||state==='INCONSISTENT'?'RESERVED':state;
  await db.pool.query(`INSERT INTO attachment_objects(id,attachment_id,attempt_id,variant,sha256,byte_count,content_type,status,put_claim,put_claimed_at,put_settled_at,put_uncertain,etag,deleted_at) VALUES($1,$2,$3,'source',$4,20,'application/octet-stream',$5,$6,$7,$8,$9,$10,$11)`,[objectId,attachmentId,attemptId,'b'.repeat(64),status,unclaimed?null:randomUUID(),unclaimed?null:new Date(),uncertain||unclaimed?null:new Date(),uncertain,uncertain||unclaimed?null:'"synthetic"',state==='DELETED'?new Date():null]);
  return {locator:{attachmentId,attemptId,objectId,kind:'source'},sizeBytes:20};
 }
 const inspect=(items:readonly ListedAttachmentObject[])=>transaction(db.pool,async c=>{await c.query('SET TRANSACTION READ ONLY');return new PostgresAttachmentOrphanRepository(c).classify(items);});
 it('classifies exact known immutable manifests without settling uncertain puts or changing object/debt rows',async()=>{
  const items=[];for(const state of ['WRITTEN','DELETE_PENDING','DELETED','UNCERTAIN','UNCLAIMED','INCONSISTENT'] as const)items.push(await object(state));
  const before=(await db.pool.query('SELECT * FROM attachment_objects ORDER BY id')).rows;
  await expect(inspect(items)).resolves.toEqual(['TRACKED','CLEANUP_PENDING','RETIRED_PRESENT','UNCERTAIN_PRESENT','UNCLAIMED_PRESENT','INCONSISTENT_MANIFEST']);
  expect((await db.pool.query('SELECT * FROM attachment_objects ORDER BY id')).rows).toEqual(before);expect((await db.pool.query('SELECT count(*)::int n FROM attachment_cleanup_jobs')).rows[0].n).toBe(0);
  await db.pool.query("UPDATE attachment_objects SET status='DELETE_PENDING',object_version=object_version+1 WHERE id=$1",[items[4].locator.objectId]);
  await expect(inspect([items[4]])).resolves.toEqual(['UNCLAIMED_PRESENT']);
 });
 it('requires complete locator and size match; a valid object ID is never ownership authority',async()=>{
  const item=await object('WRITTEN'),foreign=await attachment();
  for(const changed of [{...item,locator:{...item.locator,attachmentId:foreign}},{...item,locator:{...item.locator,attemptId:randomUUID()}},{...item,locator:{...item.locator,kind:'normalized' as const}},{...item,sizeBytes:21}])await expect(inspect([changed])).resolves.toEqual(['OWNERSHIP_MISMATCH']);
  await expect(inspect([{...item,locator:{...item.locator,objectId:randomUUID()}}])).resolves.toEqual(['UNKNOWN_PRESENT']);
 });
 it('alerts safe aggregate events for unknown and retired observed objects without any cleanup/provider operations',async()=>{
  const retired=await object('DELETED'),unknown={locator:{attachmentId:randomUUID(),attemptId:randomUUID(),objectId:randomUUID(),kind:'source' as const},sizeBytes:20},alerts:unknown[]=[];
  const before=(await db.pool.query('SELECT * FROM attachment_objects ORDER BY id')).rows;
  const detector=new AttachmentOrphanDetector(new PostgresAttachmentOrphanRepository(db.pool),{listOwnedPrefix:async()=>({objects:[retired,unknown],unrecognizedObjects:1})},e=>{alerts.push(e);});
  expect(await detector.inspectNextPage()).toMatchObject({inspected:2,unrecognized:1,classifications:{RETIRED_PRESENT:1,UNKNOWN_PRESENT:1}});
  expect(JSON.stringify(alerts)).not.toContain(retired.locator.objectId);expect(JSON.stringify(alerts)).not.toContain(unknown.locator.objectId);
  expect((await db.pool.query('SELECT * FROM attachment_objects ORDER BY id')).rows).toEqual(before);expect((await db.pool.query('SELECT count(*)::int n FROM attachment_cleanup_jobs')).rows[0].n).toBe(0);
 });

 it('treats any positive object for a certified-unsent claim as manifest inconsistency',async()=>{const attachmentId=await attachment(),objectId=randomUUID(),attemptId=randomUUID();await db.pool.query("UPDATE attachments SET state='DELETED',deleted_at=clock_timestamp(),version=version+1 WHERE id=$1",[attachmentId]);await db.pool.query("INSERT INTO attachment_objects(id,attachment_id,attempt_id,variant,sha256,byte_count,content_type,status,put_claim,put_claimed_at,put_supervision_id,put_abandoned_at) VALUES($1,$2,$3,'source',$4,20,'application/octet-stream','DELETE_PENDING',$5,clock_timestamp(),$6,clock_timestamp())",[objectId,attachmentId,attemptId,'b'.repeat(64),randomUUID(),randomUUID()]);await expect(inspect([{locator:{attachmentId,attemptId,objectId,kind:'source'},sizeBytes:20}])).resolves.toEqual(['INCONSISTENT_MANIFEST']);expect((await db.pool.query('SELECT etag,put_settled_at FROM attachment_objects WHERE id=$1',[objectId])).rows[0]).toEqual({etag:null,put_settled_at:null});});
});
