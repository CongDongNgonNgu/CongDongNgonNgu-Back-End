import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { SqlHarness } from '../phase22/sql-harness';
import { DirectMessageNotificationWorker } from '../../src/messaging/direct-message-notification-worker';
import { PostgresDirectConversationRepository } from '../../src/messaging/postgres-direct-conversation.repository';
import { PostgresDirectMessageRepository } from '../../src/messaging/postgres-direct-message.repository';
import { PostgresNotificationRepository } from '../../src/notifications/postgres-notification.repository';
import { PostgresConnectionNotificationAccess } from '../../src/notifications/postgres-connection-notification-access';
import { projectCurrentNotification } from '../../src/notifications/connection-notification-access';

describe('Phase26 durable message-notification PostgreSQL worker', () => {
  const db = new SqlHarness();
  beforeAll(async () => {
    await db.open();
    expect((await db.pool.query(`SELECT extname FROM pg_extension
      WHERE extname IN ('pgcrypto','btree_gist','pg_trgm')`)).rowCount).toBe(3);
    await db.migration('0027_phase22_study_groups.down.sql');
    const files = (await readdir(path.resolve(__dirname, '../../database/migrations')))
      .filter(file => /^\d{4}_[\w-]+\.sql$/.test(file)
        && Number(file.slice(0, 4)) >= 2 && Number(file.slice(0, 4)) <= 36).sort();
    expect(files).toHaveLength(35);
    for (const file of files) await db.migration(file);
  }, 180000);
  afterAll(async () => { await db.close(); });
  beforeEach(async () => { await db.reset(); });

  function repositories(pool = db.pool) {
    const conversations = new PostgresDirectConversationRepository(pool);
    return { conversations, messages: new PostgresDirectMessageRepository(pool, conversations),
      notifications: new PostgresNotificationRepository(pool) };
  }

  async function pair() {
    const [sender, recipient] = [randomUUID(), randomUUID()].sort();
    const language = (await db.pool.query(`INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name)
      VALUES('en','english','English','English','English') ON CONFLICT(code) DO UPDATE SET active=true RETURNING id`)).rows[0].id;
    for (const id of [sender, recipient]) {
      await db.pool.query(`INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at)
        VALUES($1,$2,$2,'Synthetic notification actor','ACTIVE',now())`, [id, id + '@phase26.invalid']);
      await db.pool.query(`INSERT INTO language_exchange_preferences(user_id,exchange_opt_in,discoverable,contact_permission)
        VALUES($1,true,true,'RELATIONSHIP_GATED')`, [id]);
      const relation = (await db.pool.query(`INSERT INTO user_languages
        (user_id,language_id,is_known,is_learning,declared_proficiency)
        VALUES($1,$2,true,true,'B1') RETURNING id`, [id, language])).rows[0].id;
      await db.pool.query(`INSERT INTO language_exchange_languages(user_id,user_language_id,direction)
        VALUES($1,$2,'OFFER'),($1,$2,'WANT')`, [id, relation]);
    }
    await db.pool.query(`INSERT INTO language_exchange_connections
      (participant_a_id,participant_b_id,requester_id,status) VALUES($1,$2,$1,'CONNECTED')`, [sender, recipient]);
    const repos = repositories();
    const room = await repos.conversations.open(sender, recipient);
    const send = () => repos.messages.send(sender, room.id,
      { text: 'Private synthetic text must never enter a notification', clientMessageId: randomUUID() });
    return { sender, recipient, room, send, ...repos };
  }

  function worker(pool = db.pool) {
    const repos = repositories(pool);
    const published: string[] = [];
    const realtime = { publish: (record: { id: string }) => { published.push(record.id); } };
    return { ...repos, realtime, published,
      worker: new DirectMessageNotificationWorker(pool, repos.conversations, repos.notifications, realtime) };
  }

  async function notices() {
    return (await db.pool.query(`SELECT n.*,r.status AS read_status,r.read_at
      FROM notifications n JOIN notification_read_states r ON r.notification_id=n.id ORDER BY n.source_event_id`)).rows;
  }

  async function progress(conversation: string) {
    return (await db.pool.query(`SELECT generation,processed_generation,attempts,
      available_at<=clock_timestamp() AS due FROM direct_message_notification_intents WHERE conversation_id=$1`, [conversation])).rows[0];
  }

  it('coalesces repeated sends into one first-unread episode and preserves READ on replay', async () => {
    const h = await pair(); const first = await h.send(); await h.send();
    const w = worker();
    expect(await w.worker.runOnce()).toEqual({ processed: 1, failed: 0 });
    const [created] = await notices();
    expect(created).toMatchObject({ notification_type: 'DIRECT_MESSAGE', source_event_id: first.id,
      actor: { kind: 'SYSTEM', label: 'System' }, variables: {},
      target: { kind: 'DIRECT_CONVERSATION', id: h.room.id, path: `/exchange/conversations/${h.room.id}` } });
    expect(JSON.stringify(created)).not.toContain('Private synthetic text');
    const readAt = new Date('2026-10-12T00:00:00Z');
    await h.notifications.markRead(h.recipient, created.id, readAt);
    await h.send();
    expect(await w.worker.runOnce()).toEqual({ processed: 1, failed: 0 });
    expect(await notices()).toEqual([{ ...created, read_status: 'READ', read_at: readAt }]);
    expect(w.published).toEqual([created.id]);
    expect(await progress(h.room.id)).toMatchObject({ generation: '3', processed_generation: '3', attempts: 0 });
  });

  it('serializes two independent-pool workers so overlapping candidates create one notice and one hint', async () => {
    const h = await pair(); await h.send();
    const replica = new Pool({ connectionString: db.scopedUrl, max: 4 });
    let release!: () => void; let entered!: () => void; let attempted!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const claiming = new Promise<void>(resolve => { entered = resolve; });
    const secondEntered = new Promise<void>(resolve => { attempted = resolve; });
    const first = worker(); const second = worker(replica);
    const blockedClaim = { claimIntentOnClient: async (...args: Parameters<PostgresNotificationRepository['claimIntentOnClient']>) => {
      const result = await first.notifications.claimIntentOnClient(...args); entered(); await held; return result;
    } };
    const firstWorker = new DirectMessageNotificationWorker(db.pool, first.conversations, blockedClaim, first.realtime);
    const observedConversation = { withConversation: async <T>(...args: Parameters<PostgresDirectConversationRepository['withConversation']>) => {
      attempted(); return second.conversations.withConversation(...args) as Promise<T>;
    } };
    const secondWorker = new DirectMessageNotificationWorker(replica, observedConversation, second.notifications, second.realtime);
    let runs: Promise<unknown>[] = [];
    try {
      runs = [firstWorker.runOnce()]; await claiming;
      runs.push(secondWorker.runOnce()); await secondEntered; release(); await Promise.all(runs);
      expect(await notices()).toHaveLength(1);
      expect([...first.published, ...second.published]).toHaveLength(1);
      expect(await progress(h.room.id)).toMatchObject({ generation: '1', processed_generation: '1', attempts: 0 });
    } finally { release(); await Promise.allSettled(runs); await replica.end(); }
  });

  it('dirties partial reads to notify the new first unread message and suppresses after full read', async () => {
    const h = await pair(); const first = await h.send(); const second = await h.send();
    const w = worker(); await w.worker.runOnce();
    const access = new PostgresConnectionNotificationAccess(db.pool);
    const original = (await h.notifications.listForUser(h.recipient, { status: 'ALL', limit: 50 })).items[0].record;
    expect(await access.resolve(original)).toEqual({ kind: 'SYSTEM', label: 'System' });
    expect(await access.countUnread(h.recipient, h.notifications)).toBe(1);
    const before = await progress(h.room.id);
    await db.pool.query(`UPDATE direct_message_notification_intents SET attempts=16,
      available_at=clock_timestamp()+interval '1 hour' WHERE conversation_id=$1`, [h.room.id]);
    await h.messages.markRead(h.recipient, h.room.id, first.sequence);
    const dirty = await progress(h.room.id);
    expect(BigInt(dirty.generation)).toBeGreaterThan(BigInt(before.generation));
    expect(dirty).toMatchObject({ attempts: 0, due: true });
    // The old episode is unavailable immediately, even before a worker emits
    // the replacement notice for the later unread message.
    expect(await access.resolve(original)).toBeNull();
    expect(await access.countUnread(h.recipient, h.notifications)).toBe(0);
    await w.worker.runOnce();
    expect((await notices()).map(row => row.source_event_id).sort()).toEqual([first.id, second.id].sort());
    const records = (await h.notifications.listForUser(h.recipient, { status: 'ALL', limit: 50 })).items;
    const replacement = records.find(item => item.record.sourceEventId === second.id)!.record;
    expect(await access.resolve(original)).toBeNull();
    expect(await access.resolve(replacement)).toEqual({ kind: 'SYSTEM', label: 'System' });
    expect(await access.countUnread(h.recipient, h.notifications)).toBe(1);
    await h.messages.markRead(h.recipient, h.room.id, second.sequence);
    expect(await access.resolve(replacement)).toBeNull();
    expect(await access.countUnread(h.recipient, h.notifications)).toBe(0);
    await w.worker.runOnce();
    expect(await notices()).toHaveLength(2);
    const fullyRead = await progress(h.room.id);
    expect(fullyRead.processed_generation).toBe(fullyRead.generation);
  });

  it('rolls back a real notification claim on failure and resets retry delay on a new committed send', async () => {
    const h = await pair(); await h.send(); const w = worker();
    const failing = { claimIntentOnClient: async (...args: Parameters<PostgresNotificationRepository['claimIntentOnClient']>) => {
      await w.notifications.claimIntentOnClient(...args); throw new Error('Synthetic failure after insert before acknowledgement');
    } };
    const broken = new DirectMessageNotificationWorker(db.pool, w.conversations, failing, w.realtime);
    expect(await broken.runOnce()).toEqual({ processed: 0, failed: 1 });
    expect(await notices()).toEqual([]); expect(w.published).toEqual([]);
    expect(await progress(h.room.id)).toMatchObject({ generation: '1', processed_generation: '0', attempts: 1, due: false });
    expect(await w.worker.runOnce()).toEqual({ processed: 0, failed: 0 });
    await h.send();
    expect(await progress(h.room.id)).toMatchObject({ generation: '2', processed_generation: '0', attempts: 0, due: true });
    expect(await w.worker.runOnce()).toEqual({ processed: 1, failed: 0 });
    expect(await notices()).toHaveLength(1);
    expect(await progress(h.room.id)).toMatchObject({ generation: '2', processed_generation: '2', attempts: 0 });
  });

  it.each(['sender disabled', 'recipient disabled', 'sender blocks', 'recipient blocks', 'in-app disabled'])(
    'does not materialize private notices when %s at processing time', async condition => {
      const h = await pair(); await h.send();
      if (condition.endsWith('disabled') && condition !== 'in-app disabled') {
        await db.pool.query("UPDATE users SET status='DISABLED' WHERE id=$1",
          [condition.startsWith('sender') ? h.sender : h.recipient]);
      } else if (condition.endsWith('blocks')) {
        const ids = condition.startsWith('sender') ? [h.sender, h.recipient] : [h.recipient, h.sender];
        await db.pool.query('INSERT INTO language_exchange_blocks(blocker_user_id,blocked_user_id) VALUES($1,$2)', ids);
      } else await db.pool.query(`INSERT INTO notification_preferences(user_id,category,channel,enabled)
        VALUES($1,'EXCHANGE','IN_APP',false)`, [h.recipient]);
      const w = worker(); expect(await w.worker.runOnce()).toEqual({ processed: 1, failed: 0 });
      expect(await notices()).toEqual([]); expect(w.published).toEqual([]);
      expect(await progress(h.room.id)).toMatchObject({ generation: '1', processed_generation: '1', attempts: 0 });
    });

  it.each(['sender disabled', 'recipient disabled', 'sender blocks', 'recipient blocks',
    'sender no-contact', 'recipient no-contact', 'in-app disabled'])(
    'redacts retained materialized notices and current unread counts after %s', async condition => {
      const h = await pair(); await h.send(); await worker().worker.runOnce();
      const access = new PostgresConnectionNotificationAccess(db.pool);
      const { record } = (await h.notifications.listForUser(h.recipient, { status: 'ALL', limit: 50 })).items[0];
      expect(await access.resolve(record)).toEqual({ kind: 'SYSTEM', label: 'System' });
      expect(await access.countUnread(h.recipient, h.notifications)).toBe(1);
      if (condition === 'in-app disabled') {
        await db.pool.query(`INSERT INTO notification_preferences(user_id,category,channel,enabled)
          VALUES($1,'EXCHANGE','IN_APP',false)`, [h.recipient]);
      } else if (condition.endsWith('disabled')) {
        await db.pool.query("UPDATE users SET status='DISABLED' WHERE id=$1",
          [condition.startsWith('sender') ? h.sender : h.recipient]);
      } else if (condition.endsWith('no-contact')) {
        await db.pool.query("UPDATE language_exchange_preferences SET contact_permission='NO_CONTACT' WHERE user_id=$1",
          [condition.startsWith('sender') ? h.sender : h.recipient]);
      } else {
        const ids = condition.startsWith('sender') ? [h.sender, h.recipient] : [h.recipient, h.sender];
        await db.pool.query('INSERT INTO language_exchange_blocks(blocker_user_id,blocked_user_id) VALUES($1,$2)', ids);
      }
      expect(await access.resolve(record)).toBeNull();
      expect(await access.resolve(record, 'SSE')).toBeNull();
      expect(await access.countUnread(h.recipient, h.notifications)).toBe(0);
      const projected = await projectCurrentNotification(record, false, null, access);
      expect(projected.available).toBe(false);
      expect(projected.response).toMatchObject({ actor: { kind: 'DELETED', label: 'Deleted member' }, target: null, variables: {} });
      // Current visibility must not depend on deleting history or changing READ.
      expect(await h.notifications.countUnread(h.recipient)).toBe(1);
      expect(await notices()).toHaveLength(1);
    });

  it('honors SSE=false independently while IN_APP projection and current unread count remain available', async () => {
    const h = await pair(); await h.send(); await worker().worker.runOnce();
    const { record } = (await h.notifications.listForUser(h.recipient, { status: 'ALL', limit: 50 })).items[0];
    const access = new PostgresConnectionNotificationAccess(db.pool);
    expect(await access.resolve(record, 'SSE')).toEqual({ kind: 'SYSTEM', label: 'System' });
    await db.pool.query(`INSERT INTO notification_preferences(user_id,category,channel,enabled)
      VALUES($1,'EXCHANGE','SSE',false)`, [h.recipient]);
    expect(await access.resolve(record, 'SSE')).toBeNull();
    expect((await projectCurrentNotification(record, false, null, access, 'SSE')).available).toBe(false);
    expect(await access.resolve(record, 'IN_APP')).toEqual({ kind: 'SYSTEM', label: 'System' });
    expect((await projectCurrentNotification(record, false, null, access)).response.target)
      .toEqual({ kind: 'DIRECT_CONVERSATION', path: `/exchange/conversations/${h.room.id}` });
    expect(await access.countUnread(h.recipient, h.notifications)).toBe(1);
    await db.pool.query(`UPDATE notification_preferences SET enabled=true
      WHERE user_id=$1 AND category='EXCHANGE' AND channel='SSE'`, [h.recipient]);
    expect(await access.resolve(record, 'SSE')).toEqual({ kind: 'SYSTEM', label: 'System' });
  });

  it('backs off a full failing batch so a later healthy conversation cannot starve', async () => {
    const failedRooms = new Set<string>();
    for (let index = 0; index < 20; index++) {
      const h = await pair(); await h.send(); failedRooms.add(h.room.id);
    }
    const healthy = await pair(); await healthy.send();
    // Explicit ordering avoids clock-resolution assumptions in batch fairness proof.
    await db.pool.query(`UPDATE direct_message_notification_intents SET
      attempts=CASE WHEN conversation_id=$1 THEN 0 ELSE 16 END,
      available_at=CASE WHEN conversation_id=$1 THEN '2020-01-02'::timestamptz ELSE '2020-01-01'::timestamptz END`, [healthy.room.id]);
    const w = worker();
    const failingConversations = { withConversation: async <T>(...args: Parameters<PostgresDirectConversationRepository['withConversation']>) => {
      if (failedRooms.has(args[1])) throw new Error('Synthetic retryable replica failure');
      return w.conversations.withConversation(...args) as Promise<T>;
    } };
    const mixed = new DirectMessageNotificationWorker(db.pool, failingConversations, w.notifications, w.realtime);
    expect(await mixed.runOnce()).toEqual({ processed: 0, failed: 20 });
    expect(await notices()).toEqual([]);
    expect(await mixed.runOnce()).toEqual({ processed: 1, failed: 0 });
    expect(await notices()).toHaveLength(1);
    expect(await progress(healthy.room.id)).toMatchObject({ processed_generation: '1' });
    expect(Number((await db.pool.query(`SELECT count(*) AS count FROM direct_message_notification_intents
      WHERE processed_generation=0 AND attempts=16`)).rows[0].count)).toBe(20);
  }, 180000);
});
