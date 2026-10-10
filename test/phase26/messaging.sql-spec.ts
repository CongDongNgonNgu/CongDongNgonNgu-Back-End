import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SqlHarness } from '../phase22/sql-harness';

describe('Phase26 direct messaging PostgreSQL constraints', () => {
  const db = new SqlHarness();
  beforeAll(async () => {
    await db.open();
    await db.migration('0032_phase26_direct_messaging.sql');
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
    await db.migration('0032_phase26_direct_messaging.down.sql');
    expect((await db.pool.query(`SELECT to_regclass($1) AS table_name`, [db.schema + '.direct_messages'])).rows)
      .toEqual([{ table_name: null }]);
    await db.migration('0032_phase26_direct_messaging.sql');
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
