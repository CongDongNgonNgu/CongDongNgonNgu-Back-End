import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SqlHarness } from '../phase22/sql-harness';
import { PostgresDirectConversationRepository } from '../../src/messaging/postgres-direct-conversation.repository';
import { PostgresMessageStreamRepository } from '../../src/messaging/postgres-message-stream.repository';

describe('Phase26 durable direct message stream leases', () => {
  const db = new SqlHarness();
  beforeAll(async () => {
    await db.open();
    for (const file of ['0002_language_profile.sql', '0006_language_exchange_preferences.sql',
      '0007_language_exchange_connections.sql', '0008_language_exchange_safety.sql',
      '0032_phase26_direct_messaging.sql', '0033_phase26_message_intents_limits.sql',
      '0034_phase26_message_stream_leases.sql']) await db.migration(file);
  });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => { await db.reset(); });

  async function fixture() {
    const [a, b] = [randomUUID(), randomUUID()].sort();
    const language = (await db.pool.query(`INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name)
      VALUES('en','english','English','English','English') ON CONFLICT(code) DO UPDATE SET active=true RETURNING id`)).rows[0].id;
    for (const actor of [a, b]) {
      await db.pool.query(`INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at)
        VALUES($1,$2,$2,'Synthetic stream actor','ACTIVE',now())`, [actor, actor + '@phase26.invalid']);
      await db.pool.query(`INSERT INTO language_exchange_preferences(user_id,exchange_opt_in,contact_permission)
        VALUES($1,true,'RELATIONSHIP_GATED')`, [actor]);
      const row = (await db.pool.query(`INSERT INTO user_languages(user_id,language_id,is_known,is_learning,declared_proficiency)
        VALUES($1,$2,true,true,'B1') RETURNING id`, [actor, language])).rows[0];
      await db.pool.query(`INSERT INTO language_exchange_languages(user_id,user_language_id,direction)
        VALUES($1,$2,'OFFER'),($1,$2,'WANT')`, [actor, row.id]);
    }
    await db.pool.query(`INSERT INTO language_exchange_connections(participant_a_id,participant_b_id,requester_id,status)
      VALUES($1,$2,$1,'CONNECTED')`, [a, b]);
    const session = (await db.pool.query(`INSERT INTO auth_sessions(user_id,family_id,token_digest,expires_at)
      VALUES($1,$2,$3,clock_timestamp()+interval '1 hour') RETURNING id`, [a, randomUUID(), randomUUID()])).rows[0].id as string;
    const conversations = new PostgresDirectConversationRepository(db.pool);
    const conversation = await conversations.open(a, b);
    return { a, b, session, conversation, first: new PostgresMessageStreamRepository(db.pool, conversations),
      replica: new PostgresMessageStreamRepository(db.pool, new PostgresDirectConversationRepository(db.pool)) };
  }

  it('serializes cross-replica capacity, commits denied attempts and releases only exact ownership', async () => {
    const { a, session, conversation, first, replica } = await fixture();
    const outcomes = await Promise.allSettled(Array.from({ length: 12 }, (_, index) =>
      (index % 2 ? first : replica).acquire(a, conversation.id, session)));
    const leases = outcomes.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    expect(leases).toHaveLength(10);
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(2);
    for (const result of outcomes) if (result.status === 'rejected') {
      expect(result.reason).toMatchObject({ code: 'MESSAGE_STREAM_LIMIT' });
      expect(result.reason.getStatus()).toBe(429);
    }
    expect((await db.pool.query(`SELECT hits FROM direct_message_rate_limits WHERE actor_id=$1 AND bucket='STREAM_MINUTE'`, [a])).rows[0].hits).toBe(12);
    await replica.release({ ...leases[0], ownerToken: randomUUID() });
    expect((await db.pool.query('SELECT id FROM direct_message_stream_leases')).rowCount).toBe(10);
    await replica.release(leases[0]);
    expect((await db.pool.query('SELECT id FROM direct_message_stream_leases')).rowCount).toBe(9);
    const replacement = await first.acquire(a, conversation.id, session);
    expect(replacement.id).not.toBe(leases[0].id);
    await first.release(leases[0]);
    expect(await replica.poll(replacement)).toBe('0');
  });

  it('commits the denied subscribe budget and prunes expiry without reviving old leases', async () => {
    const { a, session, conversation, first, replica } = await fixture();
    const old = await first.acquire(a, conversation.id, session);
    await db.pool.query(`UPDATE direct_message_stream_leases SET expires_at=clock_timestamp()-interval '1 second'`);
    await expect(replica.poll(old)).rejects.toMatchObject({ code: 'MESSAGE_STREAM_EXPIRED' });
    const current = await replica.acquire(a, conversation.id, session);
    expect((await db.pool.query('SELECT id FROM direct_message_stream_leases')).rows).toEqual([{ id: current.id }]);
    const seconds = (await db.pool.query(`SELECT EXTRACT(EPOCH FROM expires_at-clock_timestamp())::float AS seconds
      FROM direct_message_stream_leases WHERE id=$1`, [current.id])).rows[0].seconds;
    expect(seconds).toBeGreaterThan(55);
    expect(seconds).toBeLessThanOrEqual(60);
    await db.pool.query(`UPDATE direct_message_rate_limits SET hits=30 WHERE actor_id=$1 AND bucket='STREAM_MINUTE'`, [a]);
    await expect(first.acquire(a, conversation.id, session)).rejects.toMatchObject({ code: 'MESSAGE_STREAM_RATE_LIMITED' });
    expect((await db.pool.query(`SELECT hits FROM direct_message_rate_limits WHERE actor_id=$1 AND bucket='STREAM_MINUTE'`, [a])).rows[0].hits).toBe(31);
    expect((await db.pool.query('SELECT id FROM direct_message_stream_leases')).rowCount).toBe(1);
  });

  it('polls persisted versions across replicas and denies session or pair revocation', async () => {
    const { a, b, session, conversation, first, replica } = await fixture();
    const lease = await first.acquire(a, conversation.id, session);
    await db.pool.query('UPDATE direct_conversations SET change_version=9007199254740993 WHERE id=$1', [conversation.id]);
    expect(await replica.poll(lease)).toBe('9007199254740993');
    await expect(replica.poll({ ...lease, sessionId: randomUUID() })).rejects.toMatchObject({ code: 'MESSAGE_STREAM_EXPIRED' });
    await db.pool.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [session]);
    await expect(replica.poll(lease)).rejects.toMatchObject({ code: 'AUTH_SESSION_EXPIRED' });
    await db.pool.query('UPDATE auth_sessions SET revoked_at=NULL WHERE id=$1', [session]);
    await db.pool.query(`INSERT INTO language_exchange_blocks(blocker_user_id,blocked_user_id) VALUES($1,$2)`, [a, b]);
    await expect(first.poll(lease)).rejects.toMatchObject({ code: 'CONVERSATION_UNAVAILABLE' });
  });

  it('cannot resurrect a lease that expires while renewal waits on its row lock', async () => {
    const { a, session, conversation, first, replica } = await fixture();
    const lease = await first.acquire(a, conversation.id, session);
    await db.pool.query(`UPDATE direct_message_stream_leases SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1`, [lease.id]);
    const holder = await db.pool.connect();
    let outcome: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM direct_message_stream_leases WHERE id=$1 FOR UPDATE', [lease.id]);
      const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      outcome = replica.poll(lease).then(value => value, (error: unknown) => error);
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < deadline) {
        waiting = (await db.pool.query(`SELECT 1 FROM pg_stat_activity
          WHERE $1=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'`, [pid])).rowCount === 1;
        if (waiting) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await holder.query(`SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))::float+0.1)
        FROM direct_message_stream_leases WHERE id=$1`, [lease.id]);
      await holder.query('COMMIT');
      expect(await outcome).toMatchObject({ code: 'MESSAGE_STREAM_EXPIRED' });
    } finally { await holder.query('ROLLBACK'); holder.release(); await outcome; }
    expect((await db.pool.query(`SELECT expires_at<=clock_timestamp() AS expired
      FROM direct_message_stream_leases WHERE id=$1`, [lease.id])).rows[0].expired).toBe(true);
  });

  it('refuses downgrade with a live lease and preserves send counters when ephemeral stream state expires', async () => {
    const { a, session, conversation, first } = await fixture();
    await first.acquire(a, conversation.id, session);
    const down = await readFile(path.resolve(__dirname, '../../database/migrations/0034_phase26_message_stream_leases.down.sql'), 'utf8');
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await expect(client.query(down)).rejects.toMatchObject({ code: 'P0001' });
      await client.query('ROLLBACK');
      await client.query(`UPDATE direct_message_stream_leases SET expires_at=clock_timestamp()-interval '1 second'`);
      await client.query(`INSERT INTO direct_message_rate_limits(actor_id,bucket,hits,reset_at)
        VALUES($1,'SEND_MINUTE',1,clock_timestamp()+interval '1 minute')`, [a]);
      await client.query('BEGIN');
      await client.query(down);
      await client.query('COMMIT');
      expect((await client.query('SELECT bucket,hits FROM direct_message_rate_limits')).rows).toEqual([{ bucket: 'SEND_MINUTE', hits: 1 }]);
    } finally { await client.query('ROLLBACK'); client.release(); }
    await db.migration('0034_phase26_message_stream_leases.sql');
  });
});
