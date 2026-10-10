import { randomUUID } from 'node:crypto';
import { SqlHarness } from '../phase22/sql-harness';

describe('Phase26 canonical context schema', () => {
  const db = new SqlHarness();
  beforeAll(async () => {
    await db.open();
    await db.migration('0032_phase26_direct_messaging.sql');
    await db.migration('0035_phase26_message_context.sql');
  });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => { await db.reset(); });

  async function fixture() {
    const [a, b] = [randomUUID(), randomUUID()].sort();
    for (const id of [a, b]) await db.pool.query(`INSERT INTO users(id,email,normalized_email,display_name)
      VALUES($1,$2,$2,'Synthetic context schema')`, [id, id + '@phase26.invalid']);
    const id = (await db.pool.query(`INSERT INTO direct_conversations(participant_a_id,participant_b_id)
      VALUES($1,$2) RETURNING id`, [a, b])).rows[0].id;
    return { a, b, id };
  }
  const insert = `INSERT INTO direct_messages(conversation_id,participant_a_id,participant_b_id,
    sender_user_id,sequence,text,client_message_id,context_type,context_id) VALUES($1,$2,$3,$2,1,$4,$5,$6,$7)`;

  it.each(['LIBRARY_RESOURCE', 'COMMUNITY_POST'])('allows reference-only %s without snapshot or target lifetime coupling', async type => {
    const { a, b, id } = await fixture(), target = randomUUID();
    await db.pool.query(insert, [id, a, b, '', randomUUID(), type, target]);
    const row = (await db.pool.query('SELECT * FROM direct_messages WHERE conversation_id=$1', [id])).rows[0];
    expect(row.text).toBe('');expect(row.context_type).toBe(type);expect(row.context_id).toBe(target);
    expect(Object.keys(row).filter(key => /title|body|url|snapshot|author/.test(key))).toEqual([]);
  });

  it.each([[null, randomUUID()], ['LIBRARY_RESOURCE', null], ['UNKNOWN', randomUUID()],
    [null, null]])('rejects incomplete/unsupported reference or empty unreferenced text: %j', async (type, target) => {
    const { a, b, id } = await fixture();
    await db.invalidCommit(insert, [id, a, b, '', randomUUID(), type, target], '23514');
  });

  it('preserves text-only and4000-code-point bounds', async () => {
    const { a, b, id } = await fixture();
    await db.pool.query(insert, [id, a, b, '🌏'.repeat(4000), randomUUID(), null, null]);
    await db.invalidCommit(insert.replace(',1,$4', ',2,$4'),
      [id, a, b, '🌏'.repeat(4001), randomUUID(), 'LIBRARY_RESOURCE', randomUUID()], '23514');
  });

  it('refuses destructive downgrade while a context reference is retained', async () => {
    const { a, b, id } = await fixture();
    await db.pool.query(insert, [id, a, b, 'note', randomUUID(), 'LIBRARY_RESOURCE', randomUUID()]);
    await expect(db.migration('0035_phase26_message_context.down.sql')).rejects.toMatchObject({ code: 'P0001' });
    expect((await db.pool.query('SELECT context_type FROM direct_messages')).rows[0].context_type).toBe('LIBRARY_RESOURCE');
  });

  it('downgrades and upgrades without losing retained text-only messages', async () => {
    const { a, b, id } = await fixture();
    await db.pool.query(insert, [id, a, b, 'retained text', randomUUID(), null, null]);
    await db.migration('0035_phase26_message_context.down.sql');
    expect((await db.pool.query('SELECT text FROM direct_messages')).rows).toEqual([{ text: 'retained text' }]);
    await db.migration('0035_phase26_message_context.sql');
    expect((await db.pool.query('SELECT text,context_type,context_id FROM direct_messages')).rows)
      .toEqual([{ text: 'retained text', context_type: null, context_id: null }]);
  });
});
