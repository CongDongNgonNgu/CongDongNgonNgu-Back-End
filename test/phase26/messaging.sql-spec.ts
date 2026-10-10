import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SqlHarness } from '../phase22/sql-harness';
import { PostgresDirectConversationRepository } from '../../src/messaging/postgres-direct-conversation.repository';
import { PostgresDirectMessageRepository } from '../../src/messaging/postgres-direct-message.repository';
import { MessageCursorCodec } from '../../src/messaging/message-cursor';

describe('Phase26 direct messaging PostgreSQL constraints', () => {
  const db = new SqlHarness();
  beforeAll(async () => {
    await db.open();
    for (const migration of ['0002_language_profile.sql', '0006_language_exchange_preferences.sql',
      '0007_language_exchange_connections.sql', '0008_language_exchange_safety.sql']) {
      await db.migration(migration);
    }
    await db.migration('0032_phase26_direct_messaging.sql');
    await db.migration('0033_phase26_message_intents_limits.sql');
    await db.migration('0035_phase26_message_context.sql');
  });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => { await db.reset(); });

  async function actors() {
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
    for (const id of ids) {
      await db.pool.query(`INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at)
        VALUES($1,$2,$2,'Synthetic messaging actor','ACTIVE',now())`, [id, id + '@phase26.invalid']);
    }
    return ids;
  }

  async function conversation(a: string, b: string) {
    return (await db.pool.query(`INSERT INTO direct_conversations(participant_a_id,participant_b_id)
      VALUES($1,$2) RETURNING id`, [a, b])).rows[0].id as string;
  }

  async function eligiblePair() {
    const [a, b, c] = await actors();
    const language = (await db.pool.query(`INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name)
      VALUES('en','english','English','English','English') ON CONFLICT(code) DO UPDATE SET active=true
      RETURNING id`)).rows[0].id;
    for (const actor of [a, b, c]) {
      await db.pool.query(`INSERT INTO language_exchange_preferences(user_id,exchange_opt_in,discoverable,contact_permission)
        VALUES($1,true,true,'RELATIONSHIP_GATED')`, [actor]);
      const relation = (await db.pool.query(`INSERT INTO user_languages(user_id,language_id,is_known,is_learning,declared_proficiency)
        VALUES($1,$2,true,true,'B1') RETURNING id`, [actor, language])).rows[0].id;
      await db.pool.query(`INSERT INTO language_exchange_languages(user_id,user_language_id,direction)
        VALUES($1,$2,'OFFER'),($1,$2,'WANT')`, [actor, relation]);
    }
    await db.pool.query(`INSERT INTO language_exchange_connections(participant_a_id,participant_b_id,requester_id,status)
      VALUES($1,$2,$1,'CONNECTED')`, [a, b]);
    return [a, b, c];
  }

  it('concurrent opposite-participant opens produce one stable authorized conversation', async () => {
    const [a, b, c] = await eligiblePair();
    const first = new PostgresDirectConversationRepository(db.pool);
    const replica = new PostgresDirectConversationRepository(db.pool);
    const [ab, ba] = await Promise.all([first.open(a, b), replica.open(b, a)]);
    expect(ab.id).toBe(ba.id);
    expect(ab).toMatchObject({ headSequence: '0', changeVersion: '0', lastReadSequence: '0', unreadCount: '0',
      partner: { userId: b, displayName: 'Synthetic messaging actor' } });
    expect((await first.open(a, b)).id).toBe(ab.id);
    await expect(first.open(c, b)).rejects.toMatchObject({ code: 'CONVERSATION_UNAVAILABLE' });
    await expect(first.get(c, ab.id)).rejects.toMatchObject({ code: 'CONVERSATION_UNAVAILABLE' });
    expect((await db.pool.query('SELECT id FROM direct_conversations')).rows).toEqual([{ id: ab.id }]);
  });

  it('lists current authorized conversations with bounded exact microsecond keyset pages', async () => {
    const [a, b, c] = await eligiblePair();
    const codec = new MessageCursorCodec('synthetic-list-cursor-key');
    const repository = new PostgresDirectConversationRepository(db.pool, codec);
    const partners = Array.from({ length: 22 }, () => randomUUID());
    await db.pool.query(`INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at)
      SELECT id,id::text||'@phase26.invalid',id::text||'@phase26.invalid','Synthetic list partner','ACTIVE',now()
      FROM unnest($1::uuid[]) id`, [partners]);
    await db.pool.query(`INSERT INTO language_exchange_preferences(user_id,exchange_opt_in,discoverable,contact_permission)
      SELECT id,true,true,'RELATIONSHIP_GATED' FROM unnest($1::uuid[]) id`, [partners]);
    await db.pool.query(`INSERT INTO user_languages(user_id,language_id,is_known,is_learning,declared_proficiency)
      SELECT id,(SELECT language_id FROM user_languages WHERE user_id=$2 LIMIT 1),true,true,'B1'
      FROM unnest($1::uuid[]) id`, [partners, a]);
    await db.pool.query(`INSERT INTO language_exchange_languages(user_id,user_language_id,direction)
      SELECT u.user_id,u.id,d::exchange_language_direction FROM user_languages u CROSS JOIN (VALUES('OFFER'),('WANT')) directions(d)
      WHERE u.user_id=ANY($1::uuid[])`, [partners]);
    await db.pool.query(`INSERT INTO language_exchange_connections(participant_a_id,participant_b_id,requester_id,status)
      SELECT LEAST($2::uuid,id),GREATEST($2::uuid,id),$2,'CONNECTED' FROM unnest($1::uuid[]) id`, [partners, a]);
    await db.pool.query(`INSERT INTO direct_conversations(participant_a_id,participant_b_id,updated_at)
      SELECT LEAST($2::uuid,id),GREATEST($2::uuid,id),
        '2026-10-10T01:02:03.004000Z'::timestamptz + n * interval '1 microsecond'
      FROM unnest($1::uuid[]) WITH ORDINALITY partners(id,n)`, [partners, a]);
    await repository.open(a, b);
    await db.pool.query(`UPDATE language_exchange_preferences SET contact_permission='NO_CONTACT' WHERE user_id=$1`, [b]);
    const expected = (await db.pool.query(`SELECT id FROM direct_conversations
      WHERE participant_a_id<>$1 AND participant_b_id<>$1 ORDER BY updated_at DESC,id DESC`, [b])).rows.map(row => row.id);
    const first = await repository.list(a);
    expect(first.items.map(row => row.id)).toEqual(expected.slice(0, 20));
    expect(first.items.every(row => !('text' in row) && !('preview' in row))).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    const second = await repository.list(a, { cursor: first.nextCursor!, limit: 50 });
    expect(second.items.map(row => row.id)).toEqual(expected.slice(20));
    expect(second.nextCursor).toBeNull();
    expect(await repository.list(c)).toEqual({ items: [], nextCursor: null });
    await expect(repository.list(c, { cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'MESSAGE_INVALID_CURSOR' });
    await expect(repository.list(a, { limit: 51 })).rejects.toMatchObject({ code: 'MESSAGE_INVALID_PAGE' });
    await expect(repository.list(a, { cursor: 'malformed!' })).rejects.toMatchObject({ code: 'MESSAGE_INVALID_CURSOR' });
  }, 120_000);

  it('continues beyond a full bounded scan of retained inaccessible conversations', async () => {
    const [a, b] = await eligiblePair();
    const repository = new PostgresDirectConversationRepository(db.pool, new MessageCursorCodec('synthetic-list-key'));
    const accessible = await repository.open(a, b);
    await db.pool.query(`UPDATE direct_conversations SET updated_at='2026-01-01T00:00:00Z' WHERE id=$1`, [accessible.id]);
    const revoked = Array.from({ length: 100 }, () => randomUUID());
    await db.pool.query(`INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at)
      SELECT id,id::text||'@phase26.invalid',id::text||'@phase26.invalid','Retained unavailable actor','ACTIVE',now()
      FROM unnest($1::uuid[]) id`, [revoked]);
    await db.pool.query(`INSERT INTO direct_conversations(participant_a_id,participant_b_id,updated_at)
      SELECT LEAST($2::uuid,id),GREATEST($2::uuid,id),'2026-02-01T00:00:00Z'::timestamptz
      FROM unnest($1::uuid[]) id`, [revoked, a]);
    const first = await repository.list(a);
    expect(first.items).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    const second = await repository.list(a, { cursor: first.nextCursor! });
    expect(second.items.map(row => row.id)).toEqual([accessible.id]);
    expect(second.nextCursor).toBeNull();
  }, 240_000);

  it('omits a candidate reordered while list authorization waits for shared account locks', async () => {
    const [a, b] = await eligiblePair();
    const repository = new PostgresDirectConversationRepository(db.pool, new MessageCursorCodec('synthetic-race-list-key'));
    const opened = await repository.open(a, b);
    const writer = await db.pool.connect();
    let outcome: Promise<unknown> | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query('SELECT id FROM users WHERE id IN ($1,$2) ORDER BY id FOR UPDATE', [a, b]);
      const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      outcome = repository.list(a);
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < deadline) {
        waiting = (await db.pool.query(`SELECT 1 FROM pg_stat_activity
          WHERE $1=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'`, [pid])).rowCount === 1;
        if (waiting) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await writer.query(`UPDATE direct_conversations SET updated_at=updated_at+interval '1 microsecond' WHERE id=$1`, [opened.id]);
      await writer.query('COMMIT');
      expect(await outcome).toEqual({ items: [], nextCursor: null });
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
      await outcome;
    }
    expect((await repository.list(a)).items.map(row => row.id)).toEqual([opened.id]);
  });

  it('serializes opposite senders and duplicate retries with one immutable logical message', async () => {
    const [a, b] = await eligiblePair();
    const conversations = new PostgresDirectConversationRepository(db.pool);
    const messages = new PostgresDirectMessageRepository(db.pool, conversations);
    const replica = new PostgresDirectMessageRepository(db.pool, new PostgresDirectConversationRepository(db.pool));
    const opened = await conversations.open(a, b);
    const key = randomUUID();
    const [one, duplicate, reply] = await Promise.all([
      messages.send(a, opened.id, { clientMessageId: key, text: '  Học 🌏  ' }),
      replica.send(a, opened.id, { clientMessageId: key, text: 'Học 🌏' }),
      replica.send(b, opened.id, { clientMessageId: randomUUID(), text: 'Reply' }),
    ]);
    expect(one).toEqual(duplicate);
    expect(one.text).toBe('Học 🌏');
    expect([one.sequence, reply.sequence].sort()).toEqual(['1', '2']);
    await expect(messages.send(a, opened.id, { clientMessageId: key, text: 'Changed' }))
      .rejects.toMatchObject({ code: 'MESSAGE_IDEMPOTENCY_CONFLICT' });
    expect((await conversations.get(a, opened.id)).unreadCount).toBe('1');
    expect((await conversations.get(b, opened.id)).unreadCount).toBe('1');
    expect((await db.pool.query('SELECT next_sequence,change_version FROM direct_conversations')).rows)
      .toEqual([{ next_sequence: '3', change_version: '2' }]);
    expect((await db.pool.query(`SELECT hits FROM direct_message_rate_limits WHERE actor_id=$1 ORDER BY bucket`, [a])).rows)
      .toEqual([{ hits: 1 }, { hits: 1 }]);
    expect((await db.pool.query('SELECT generation FROM direct_message_notification_intents')).rows)
      .toEqual([{ generation: '1' }, { generation: '1' }]);
    const secondKey = randomUUID();
    const second = await messages.send(a, opened.id, { clientMessageId: secondKey, text: 'Second' });
    expect(await replica.send(a, opened.id, { clientMessageId: secondKey, text: 'Second' })).toEqual(second);
    expect((await db.pool.query(`SELECT generation FROM direct_message_notification_intents
      WHERE recipient_user_id=$1`, [b])).rows).toEqual([{ generation: '2' }]);
  });

  it('commits both denied send counters without a message, version, sequence or intent change', async () => {
    const [a, b] = await eligiblePair();
    const conversations = new PostgresDirectConversationRepository(db.pool);
    const messages = new PostgresDirectMessageRepository(db.pool, conversations);
    const opened = await conversations.open(a, b);
    const key = randomUUID();
    const first = await messages.send(a, opened.id, { clientMessageId: key, text: 'First' });
    await db.pool.query(`UPDATE direct_message_rate_limits SET hits=CASE bucket WHEN 'SEND_MINUTE' THEN 60 ELSE 1000 END
      WHERE actor_id=$1`, [a]);
    expect(await messages.send(a, opened.id, { clientMessageId: key, text: 'First' })).toEqual(first);
    await expect(messages.send(a, opened.id, { clientMessageId: randomUUID(), text: 'Denied' }))
      .rejects.toMatchObject({ code: 'MESSAGE_RATE_LIMITED' });
    expect((await db.pool.query(`SELECT hits FROM direct_message_rate_limits WHERE actor_id=$1 ORDER BY bucket`, [a])).rows)
      .toEqual([{ hits: 1001 }, { hits: 61 }]);
    expect((await db.pool.query('SELECT next_sequence,change_version FROM direct_conversations')).rows)
      .toEqual([{ next_sequence: '2', change_version: '1' }]);
    expect((await db.pool.query('SELECT id FROM direct_messages')).rowCount).toBe(1);
    expect((await db.pool.query('SELECT generation FROM direct_message_notification_intents')).rows)
      .toEqual([{ generation: '1' }]);
  });

  it.each(['REMOVE', 'BLOCK'] as const)('send waits for account locks and denies after %s wins', async reason => {
    const [a, b] = await eligiblePair();
    const conversations = new PostgresDirectConversationRepository(db.pool);
    const messages = new PostgresDirectMessageRepository(db.pool, conversations);
    const opened = await conversations.open(a, b);
    const revoker = await db.pool.connect();
    try {
      await revoker.query('BEGIN');
      await revoker.query('SELECT id FROM users WHERE id IN ($1,$2) ORDER BY id FOR UPDATE', [a, b]);
      const pid = (await revoker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const outcome = messages.send(b, opened.id, { clientMessageId: randomUUID(), text: 'Must be denied' })
        .then(() => null, (error: unknown) => error);
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < deadline) {
        waiting = (await db.pool.query(`SELECT 1 FROM pg_stat_activity
          WHERE $1=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'`, [pid])).rowCount === 1;
        if (waiting) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      if (reason === 'BLOCK') await revoker.query(`INSERT INTO language_exchange_blocks(blocker_user_id,blocked_user_id)
        VALUES($1,$2)`, [a, b]);
      if (reason === 'REMOVE') await revoker.query('DELETE FROM language_exchange_connections');
      await revoker.query('COMMIT');
      expect(await outcome).toMatchObject({ code: 'CONVERSATION_UNAVAILABLE' });
    } finally { await revoker.query('ROLLBACK'); revoker.release(); }
    expect((await db.pool.query('SELECT id FROM direct_messages')).rowCount).toBe(0);
    expect((await db.pool.query('SELECT conversation_id FROM direct_message_notification_intents')).rowCount).toBe(0);
    expect(await conversations.withConversation(a, opened.id, async () => null).catch(() => 'DENIED')).toBe('DENIED');
  });

  it('rolls back sequence, budget and message when the atomic intent insert fails', async () => {
    const [a, b] = await eligiblePair();
    const conversations = new PostgresDirectConversationRepository(db.pool);
    const messages = new PostgresDirectMessageRepository(db.pool, conversations);
    const opened = await conversations.open(a, b);
    await db.pool.query(`ALTER TABLE direct_message_notification_intents ADD CONSTRAINT synthetic_intent_failure CHECK(false)`);
    try {
      await expect(messages.send(a, opened.id, { clientMessageId: randomUUID(), text: 'Rollback' }))
        .rejects.toMatchObject({ code: '23514' });
      expect((await db.pool.query('SELECT id FROM direct_messages')).rowCount).toBe(0);
      expect((await db.pool.query('SELECT actor_id FROM direct_message_rate_limits')).rowCount).toBe(0);
      expect((await db.pool.query('SELECT next_sequence,change_version FROM direct_conversations')).rows)
        .toEqual([{ next_sequence: '1', change_version: '0' }]);
    } finally {
      await db.pool.query('ALTER TABLE direct_message_notification_intents DROP CONSTRAINT synthetic_intent_failure');
    }
    expect((await messages.send(a, opened.id, { clientMessageId: randomUUID(), text: 'Retry' })).sequence).toBe('1');
  });

  async function populatedHistory() {
    const [a, b, c] = await eligiblePair();
    const conversations = new PostgresDirectConversationRepository(db.pool);
    const opened = await conversations.open(a, b);
    await db.pool.query(`INSERT INTO direct_messages(conversation_id,participant_a_id,participant_b_id,
      sender_user_id,sequence,text,client_message_id,created_at)
      SELECT $1,$2,$3,CASE WHEN n%2=1 THEN $2::uuid ELSE $3::uuid END,n,'Message '||n,
        gen_random_uuid(),'2026-10-10T00:00:00Z' FROM generate_series(1,70) n`, [opened.id, a, b]);
    await db.pool.query('UPDATE direct_conversations SET next_sequence=71,change_version=70 WHERE id=$1', [opened.id]);
    const messages = new PostgresDirectMessageRepository(db.pool, conversations,
      new MessageCursorCodec('synthetic-messaging-history-secret'));
    return { a, b, c, conversations, messages, id: opened.id };
  }

  it('history is sequence ordered, bounded and exclusive in both directions', async () => {
    const { a, messages, id } = await populatedHistory();
    const newest = await messages.history(a, id, {});
    expect(newest.items.map(item => item.sequence)).toEqual(Array.from({ length: 30 }, (_, i) => String(i + 41)));
    const older = await messages.history(a, id, { before: newest.beforeCursor, limit: 50 });
    expect(older.items.map(item => item.sequence)).toEqual(Array.from({ length: 40 }, (_, i) => String(i + 1)));
    expect(older.nextCursor).toBeNull();
    let after = older.afterCursor;
    const recovered: string[] = [];
    for (let page = 0; page < 4; page += 1) {
      const current = await messages.history(a, id, { after, limit: 12 });
      recovered.push(...current.items.map(item => item.sequence));
      after = current.afterCursor;
      if (!current.nextCursor) break;
    }
    expect(recovered).toEqual(Array.from({ length: 30 }, (_, i) => String(i + 41)));
    expect(new Set(recovered).size).toBe(30);
  });

  it('history rejects foreign/malformed/conflicting cursors and revoked access', async () => {
    const { a, b, c, messages, id } = await populatedHistory();
    const newest = await messages.history(a, id, {});
    const codec = new MessageCursorCodec('synthetic-messaging-history-secret');
    for (const input of [{ limit: 51 }, { before: 'bad!' },
      { before: newest.beforeCursor, after: newest.afterCursor },
      { after: codec.history(a, randomUUID(), '1') },
      { before: codec.history(c, id, '1') }]) {
      await expect(messages.history(a, id, input)).rejects.toMatchObject({ code: expect.stringMatching(/^MESSAGE_INVALID_/) });
    }
    await expect(messages.history(c, id, {})).rejects.toMatchObject({ code: 'CONVERSATION_UNAVAILABLE' });
    await db.pool.query(`UPDATE language_exchange_preferences SET contact_permission='NO_CONTACT' WHERE user_id=$1`, [b]);
    await expect(messages.history(a, id, { before: newest.beforeCursor })).rejects.toMatchObject({ code: 'CONVERSATION_UNAVAILABLE' });
  });

  it('read state is actor-owned, monotonic and excludes own messages from unread', async () => {
    const { a, b, c, conversations, messages, id } = await populatedHistory();
    expect((await conversations.get(a, id)).unreadCount).toBe('35');
    await Promise.all(['10', '50', '30'].map(sequence => messages.markRead(a, id, sequence)));
    const current = await conversations.get(a, id);
    expect(current.lastReadSequence).toBe('50');
    expect(current.unreadCount).toBe('10');
    expect((await conversations.get(b, id)).lastReadSequence).toBe('0');
    expect((await conversations.get(b, id)).unreadCount).toBe('35');
    await messages.markRead(a, id, '10');
    expect((await conversations.get(a, id)).changeVersion).toBe(current.changeVersion);
    await expect(messages.markRead(a, id, '71')).rejects.toMatchObject({ code: 'MESSAGE_INVALID_READ' });
    await expect(messages.markRead(c, id, '50')).rejects.toMatchObject({ code: 'CONVERSATION_UNAVAILABLE' });
    await db.pool.query('DELETE FROM language_exchange_connections');
    await expect(messages.markRead(a, id, '70')).rejects.toMatchObject({ code: 'CONVERSATION_UNAVAILABLE' });
  });

  it.each(['REMOVE', 'BLOCK', 'NO_CONTACT', 'OPT_OUT', 'DISABLE', 'PRIVATE_LANGUAGE', 'UNVERIFIED'] as const)
    ('current %s revocation denies retained conversation get and open', async reason => {
      const [a, b] = await eligiblePair();
      const repository = new PostgresDirectConversationRepository(db.pool);
      const opened = await repository.open(a, b);
      if (reason === 'REMOVE') await db.pool.query('DELETE FROM language_exchange_connections');
      if (reason === 'BLOCK') await db.pool.query(`INSERT INTO language_exchange_blocks(blocker_user_id,blocked_user_id)
        VALUES($1,$2)`, [b, a]);
      if (reason === 'NO_CONTACT') await db.pool.query(`UPDATE language_exchange_preferences SET contact_permission='NO_CONTACT' WHERE user_id=$1`, [b]);
      if (reason === 'OPT_OUT') await db.pool.query('UPDATE language_exchange_preferences SET exchange_opt_in=false WHERE user_id=$1', [b]);
      if (reason === 'DISABLE') await db.pool.query(`UPDATE users SET status='DISABLED' WHERE id=$1`, [b]);
      if (reason === 'PRIVATE_LANGUAGE') await db.pool.query(`UPDATE user_languages SET visibility='PRIVATE' WHERE user_id=$1`, [b]);
      if (reason === 'UNVERIFIED') await db.pool.query('UPDATE users SET email_verified_at=NULL WHERE id=$1', [b]);
      await expect(repository.get(a, opened.id)).rejects.toMatchObject({ code: 'CONVERSATION_UNAVAILABLE' });
      await expect(repository.open(a, b)).rejects.toMatchObject({ code: 'CONVERSATION_UNAVAILABLE' });
      expect((await db.pool.query('SELECT id FROM direct_conversations')).rows).toEqual([{ id: opened.id }]);
    });

  it('discovery opt-out preserves messaging while a fresh connection reuses retained history identity', async () => {
    const [a, b] = await eligiblePair();
    const repository = new PostgresDirectConversationRepository(db.pool);
    const opened = await repository.open(a, b);
    await db.pool.query('UPDATE language_exchange_preferences SET discoverable=false WHERE user_id=$1', [b]);
    expect((await repository.get(a, opened.id)).id).toBe(opened.id);
    await db.pool.query('DELETE FROM language_exchange_connections');
    await expect(repository.open(a, b)).rejects.toMatchObject({ code: 'CONVERSATION_UNAVAILABLE' });
    await db.pool.query(`INSERT INTO language_exchange_connections(participant_a_id,participant_b_id,requester_id,status)
      VALUES($1,$2,$2,'CONNECTED')`, [a, b]);
    expect((await repository.open(b, a)).id).toBe(opened.id);
  });

  const insertMessage = `INSERT INTO direct_messages(conversation_id,participant_a_id,participant_b_id,
    sender_user_id,sequence,text,client_message_id) VALUES($1,$2,$3,$4,$5,$6,$7)`;

  it('allows only one ordered distinct pair and retains conversation after relationship absence', async () => {
    const [a, b] = await actors();
    const id = await conversation(a, b);
    await db.invalidCommit(`INSERT INTO direct_conversations(participant_a_id,participant_b_id)
      VALUES($1,$2)`, [a, b], '23505');
    await db.invalidCommit(`INSERT INTO direct_conversations(participant_a_id,participant_b_id)
      VALUES($1,$2)`, [b, a], '23514');
    await db.invalidCommit(`INSERT INTO direct_conversations(participant_a_id,participant_b_id)
      VALUES($1,$2)`, [a, a], '23514');
    expect((await db.pool.query('SELECT id FROM direct_conversations')).rows).toEqual([{ id }]);
  });

  it('enforces the actual conversation participants independently of caller-supplied pair columns', async () => {
    const [a, b, c] = await actors();
    const id = await conversation(a, b);
    await db.invalidCommit(insertMessage, [id, a, b, c, '1', 'Hello', randomUUID()], '23514');
    await db.invalidCommit(insertMessage, [id, a, c, c, '1', 'Hello', randomUUID()], '23503');
    expect((await db.pool.query('SELECT id FROM direct_messages')).rowCount).toBe(0);
  });

  it('enforces positive sequence, sequence uniqueness and sender idempotency uniqueness', async () => {
    const [a, b] = await actors();
    const id = await conversation(a, b);
    const key = randomUUID();
    await db.pool.query(insertMessage, [id, a, b, a, '1', 'Hello', key]);
    await db.invalidCommit(insertMessage, [id, a, b, b, '1', 'Reply', randomUUID()], '23505');
    await db.invalidCommit(insertMessage, [id, a, b, a, '2', 'Changed text', key], '23505');
    await db.invalidCommit(insertMessage, [id, a, b, b, '0', 'Reply', randomUUID()], '23514');
    expect((await db.pool.query('SELECT sequence,text FROM direct_messages')).rows)
      .toEqual([{ sequence: '1', text: 'Hello' }]);
  });

  it('counts astral Unicode as code points and rejects empty or oversized persisted messages', async () => {
    const [a, b] = await actors();
    const id = await conversation(a, b);
    await db.pool.query(insertMessage, [id, a, b, a, '1', '🌏'.repeat(4000), randomUUID()]);
    for (const text of ['', '🌏'.repeat(4001)]) {
      await db.invalidCommit(insertMessage, [id, a, b, a, '2', text, randomUUID()], '23514');
    }
    expect((await db.pool.query('SELECT char_length(text) AS length FROM direct_messages')).rows)
      .toEqual([{ length: 4000 }]);
  });

  it('rejects future read positions and cascades participant deletion to retained communication data', async () => {
    const [a, b] = await actors();
    const id = await conversation(a, b);
    await db.invalidCommit('UPDATE direct_conversations SET last_read_a=1 WHERE id=$1', [id], '23514');
    await db.invalidCommit('UPDATE direct_conversations SET change_version=-1 WHERE id=$1', [id], '23514');
    await db.pool.query(insertMessage, [id, a, b, b, '1', 'Hello', randomUUID()]);
    await db.pool.query('DELETE FROM users WHERE id=$1', [a]);
    expect((await db.pool.query('SELECT id FROM direct_conversations')).rowCount).toBe(0);
    expect((await db.pool.query('SELECT id FROM direct_messages')).rowCount).toBe(0);
  });

  it('refuses rollback with retained history and allows empty disposable-schema rollback', async () => {
    const [a, b] = await actors();
    const id = await conversation(a, b);
    await expect(db.migration('0032_phase26_direct_messaging.down.sql')).rejects.toMatchObject({ code: 'P0001' });
    expect((await db.pool.query('SELECT id FROM direct_conversations')).rows).toEqual([{ id }]);
    await db.reset();
    await db.migration('0033_phase26_message_intents_limits.down.sql');
    await db.migration('0032_phase26_direct_messaging.down.sql');
    expect((await db.pool.query(`SELECT to_regclass($1) AS table_name`, [db.schema + '.direct_messages'])).rows)
      .toEqual([{ table_name: null }]);
    await db.migration('0032_phase26_direct_messaging.sql');
    await db.migration('0033_phase26_message_intents_limits.sql');
  });

  it('checks rollback emptiness after excluding a concurrent writer', async () => {
    const [a, b] = await actors();
    const writer = await db.pool.connect();
    const downgrade = await db.pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query('LOCK TABLE direct_conversations IN ROW EXCLUSIVE MODE');
      await downgrade.query('BEGIN');
      const pid = (await downgrade.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const sql = await readFile(path.resolve(__dirname,
        '../../database/migrations/0032_phase26_direct_messaging.down.sql'), 'utf8');
      const outcome = downgrade.query(sql).then(() => null, (error: unknown) => error);
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < deadline) {
        waiting = (await db.pool.query(`SELECT 1 FROM pg_stat_activity
          WHERE pid=$1 AND wait_event_type='Lock'`, [pid])).rowCount === 1;
        if (waiting) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await writer.query(`INSERT INTO direct_conversations(participant_a_id,participant_b_id)
        VALUES($1,$2)`, [a, b]);
      await writer.query('COMMIT');
      expect(await outcome).toMatchObject({ code: 'P0001' });
    } finally {
      await writer.query('ROLLBACK');
      await downgrade.query('ROLLBACK');
      writer.release();
      downgrade.release();
    }
    expect((await db.pool.query('SELECT id FROM direct_conversations')).rowCount).toBe(1);
  });
});
