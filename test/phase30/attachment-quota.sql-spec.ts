import {randomUUID} from 'node:crypto';
import {readdir} from 'node:fs/promises';import path from 'node:path';
import {SqlHarness} from '../phase22/sql-harness';import {transaction} from '../../src/study-groups/study-group.store';
import {AttachmentQuotaLedger} from '../../src/attachments/attachment-quota-ledger';
describe('Phase30 atomic quota/rate counters',()=>{
 const db=new SqlHarness();const actor=randomUUID();let now=new Date('2026-10-22T10:59:59.999Z');const ledger=new AttachmentQuotaLedger(async()=>new Date(now));
 beforeAll(async()=>{await db.open();await db.migration('0027_phase22_study_groups.down.sql');const files=(await readdir(path.resolve(__dirname,'../../database/migrations'))).filter(f=>/^\d{4}_[\w-]+\.sql$/.test(f)&&Number(f.slice(0,4))>=2&&Number(f.slice(0,4))<=39).sort();for(const f of files)await db.migration(f);},180000);
 afterAll(async()=>db.close());beforeEach(async()=>{await db.pool.query('TRUNCATE attachment_quota_counters');now=new Date('2026-10-22T10:59:59.999Z');});
 it('reserves actor physical bytes atomically under concurrent requests',async()=>{
  const results=await Promise.allSettled(Array.from({length:5},()=>transaction(db.pool,c=>ledger.changeReservation(c,actor,16*1048576,1))));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(4);
  const rows=(await db.pool.query("SELECT kind,used FROM attachment_quota_counters WHERE action='bytes' ORDER BY kind")).rows;
  expect(rows.map(r=>Number(r.used))).toEqual([64*1048576,64*1048576]);
 });
 it('does not partially consume actor budget when the global upload slot is busy',async()=>{
  await transaction(db.pool,c=>ledger.changeSlots(c,actor,'upload',1));
  const other=randomUUID();await expect(transaction(db.pool,c=>ledger.changeSlots(c,other,'upload',1))).rejects.toThrow('ATTACHMENT_BUSY');
  expect((await db.pool.query("SELECT count(*)::int n FROM attachment_quota_counters WHERE kind='ACTOR' AND subject=$1",[other])).rows[0].n).toBe(0);
  await transaction(db.pool,c=>ledger.changeSlots(c,actor,'upload',-1));
  await expect(transaction(db.pool,c=>ledger.changeSlots(c,other,'upload',1))).resolves.toBeUndefined();
 });
 it('charges bounded failed/new initiation attempts and resets exactly at a UTC hour',async()=>{
  for(let i=0;i<10;i++)await transaction(db.pool,c=>ledger.consumeInitiation(c,actor,1));
  await expect(transaction(db.pool,c=>ledger.consumeInitiation(c,actor,1))).rejects.toThrow('ATTACHMENT_RATE_LIMITED');
  now=new Date('2026-10-22T11:00:00.000Z');await expect(transaction(db.pool,c=>ledger.consumeInitiation(c,actor,1))).resolves.toBeUndefined();
 });
 it('caps expected source traffic even before a full initiation count is consumed',async()=>{
  for(let i=0;i<8;i++)await transaction(db.pool,c=>ledger.consumeInitiation(c,actor,4*1048576));
  await expect(transaction(db.pool,c=>ledger.consumeInitiation(c,actor,1))).rejects.toThrow('ATTACHMENT_RATE_LIMITED');
 });
 it('separates anonymous trusted-IP buckets',async()=>{
  const ip='a'.repeat(64);for(let i=0;i<30;i++)await transaction(db.pool,c=>ledger.consumeRead(c,null,ip));
  await expect(transaction(db.pool,c=>ledger.consumeRead(c,null,ip))).rejects.toThrow('ATTACHMENT_RATE_LIMITED');
  await expect(transaction(db.pool,c=>ledger.consumeRead(c,null,'b'.repeat(64)))).resolves.toBeUndefined();
  await expect(transaction(db.pool,c=>ledger.consumeRead(c,null,'spoofed-forwarded-header'))).rejects.toThrow('ATTACHMENT_QUOTA_INTEGRITY');
 });
 it('rejects a new earlier lock when independent operations are composed in one transaction',async()=>{
  await expect(transaction(db.pool,async c=>{await ledger.changeReservation(c,actor,1024,1);await ledger.changeSlots(c,actor,'upload',1);})).rejects.toThrow('ATTACHMENT_QUOTA_LOCK_ORDER');
  expect((await db.pool.query('SELECT count(*)::int n FROM attachment_quota_counters')).rows[0].n).toBe(0);
 });
 it('batches reservation and slot transitions in one sorted capacity union',async()=>{
  await transaction(db.pool,c=>ledger.changeCapacity(c,actor,{bytesDelta:1024,metadataDelta:1,uploadDelta:1}));
  expect((await db.pool.query('SELECT count(*)::int n FROM attachment_quota_counters WHERE used>0')).rows[0].n).toBe(5);
  await transaction(db.pool,c=>ledger.changeCapacity(c,actor,{bytesDelta:-1024,metadataDelta:-1,uploadDelta:-1,pendingDelta:1}));
  expect((await db.pool.query('SELECT sum(used)::int n FROM attachment_quota_counters')).rows[0].n).toBe(1);
 });
 it('never releases more physical bytes than a durable reservation',async()=>{
  await transaction(db.pool,c=>ledger.changeReservation(c,actor,1024,1));
  await expect(transaction(db.pool,c=>ledger.changeReservation(c,actor,-1025,-1))).rejects.toThrow('ATTACHMENT_QUOTA_EXCEEDED');
  await transaction(db.pool,c=>ledger.changeReservation(c,actor,-1024,-1));
  expect((await db.pool.query('SELECT sum(used)::int n FROM attachment_quota_counters')).rows[0].n).toBe(0);
 });
});
