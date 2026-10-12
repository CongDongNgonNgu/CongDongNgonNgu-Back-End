import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { SqlHarness } from '../phase22/sql-harness';
import { NOTIFICATION_TYPES } from '../../src/notifications/notification.contracts';

const up = '0036_phase26_message_notifications.sql';
const down = '0036_phase26_message_notifications.down.sql';
const priorTypes = NOTIFICATION_TYPES.filter(type => type !== 'DIRECT_MESSAGE');

async function baseline(db: SqlHarness) {
  await db.open();
  const extensions = await db.pool.query(`SELECT extname FROM pg_extension
    WHERE extname IN ('pgcrypto','btree_gist','pg_trgm')`);
  expect(extensions.rowCount).toBe(3);
  await db.migration('0027_phase22_study_groups.down.sql');
  const files = (await readdir(path.resolve(__dirname, '../../database/migrations')))
    .filter(file => /^\d{4}_[\w-]+\.sql$/.test(file)
      && Number(file.slice(0, 4)) >= 2 && Number(file.slice(0, 4)) <= 35).sort();
  expect(files).toHaveLength(34);
  for (const file of files) await db.migration(file);
  const users = [randomUUID(), randomUUID()].sort();
  for (const id of users) await db.pool.query(`INSERT INTO users
    (id,email,normalized_email,display_name,status,email_verified_at)
    VALUES($1,$2,$2,'Synthetic schema actor','ACTIVE',now())`, [id, id + '@phase26.invalid']);
  const conversation = randomUUID();
  await db.pool.query(`INSERT INTO direct_conversations(id,participant_a_id,participant_b_id)
    VALUES($1,$2,$3)`, [conversation, ...users]);
  // Existing pre-up durable work must survive the additive backfill.
  await db.pool.query(`INSERT INTO direct_message_notification_intents
    (conversation_id,recipient_user_id,generation) VALUES($1,$2,3)`, [conversation, users[1]]);
  return { conversation, recipient: users[1], otherParticipant: users[0] };
}

async function notice(db: SqlHarness, recipient: string, type: string) {
  const id = randomUUID();
  const hash = id.replace(/-/g, '').repeat(2);
  await db.pool.query(`INSERT INTO notifications
    (id,intent_id,deduplication_key,recipient_user_id,notification_type,category,priority,
     actor,variables,retention,source_event_id,source_event_type,source_event_version,
     source_aggregate_type,source_aggregate_id,source_idempotency_key,source_payload_hash,intent_fingerprint)
    VALUES($1::uuid,$2,$1::text,$3,$4,'EXCHANGE','NORMAL','{"kind":"SYSTEM","label":"System"}',
      '{}','{"mode":"DAYS","days":180}',$1::uuid,'messaging.direct.unread',1,
      'DIRECT_CONVERSATION',$1::uuid,$1::text,$2,$2)`, [id, hash, recipient, type]);
  return id;
}

async function intent(db: SqlHarness) {
  return (await db.pool.query('SELECT * FROM direct_message_notification_intents')).rows[0];
}

it('0036 preserves all notification types and backfills bounded durable progress on the full ordered baseline', async () => {
  const db = new SqlHarness();
  try {
    const { recipient, otherParticipant: freshRecipient } = await baseline(db);
    for (const type of priorTypes) await notice(db, recipient, type);
    const previousNotices = (await db.pool.query('SELECT * FROM notifications ORDER BY id')).rows;
    const previousIntent = await intent(db);
    await db.migration(up);
    expect((await db.pool.query('SELECT * FROM notifications ORDER BY id')).rows).toEqual(previousNotices);
    expect(await intent(db)).toMatchObject({ ...previousIntent, processed_generation: '0', attempts: 0,
      available_at: expect.any(Date) });
    await db.pool.query(`INSERT INTO direct_message_notification_intents
      (conversation_id,recipient_user_id,generation) SELECT conversation_id,$1,1
      FROM direct_message_notification_intents LIMIT 1`, [freshRecipient]);
    expect((await db.pool.query(`SELECT processed_generation,attempts,available_at
      FROM direct_message_notification_intents WHERE recipient_user_id=$1`, [freshRecipient])).rows[0])
      .toEqual({ processed_generation: '0', attempts: 0, available_at: expect.any(Date) });
    await notice(db, recipient, 'DIRECT_MESSAGE');
    expect((await db.pool.query('SELECT notification_type FROM notifications ORDER BY notification_type')).rows
      .map(row => row.notification_type)).toEqual([...NOTIFICATION_TYPES].sort());
    for (const values of [[-1, 0], [4, 0], [0, -1], [0, 17]]) {
      await db.invalidCommit(`UPDATE direct_message_notification_intents
        SET processed_generation=$1,attempts=$2 WHERE recipient_user_id=$3`, [...values, recipient], '23514');
    }
    for (const column of ['processed_generation', 'attempts', 'available_at']) {
      await db.invalidCommit(`UPDATE direct_message_notification_intents
        SET ${column}=NULL WHERE recipient_user_id=$1`, [recipient], '23502');
    }
    const index = (await db.pool.query(`SELECT indexdef FROM pg_indexes
      WHERE schemaname=current_schema() AND indexname='direct_message_notification_due_idx'`)).rows[0];
    expect(index.indexdef).toMatch(/\(available_at, updated_at, conversation_id, recipient_user_id\)/);
    expect(index.indexdef).toMatch(/WHERE \(processed_generation < generation\)/);
    await db.pool.query(`UPDATE direct_message_notification_intents
      SET processed_generation=generation,attempts=16 WHERE recipient_user_id=$1`, [recipient]);
    expect((await db.pool.query(`SELECT recipient_user_id FROM direct_message_notification_intents
      WHERE processed_generation<generation ORDER BY recipient_user_id`)).rows).toEqual([{ recipient_user_id: freshRecipient }]);
    await db.pool.query(`UPDATE direct_message_notification_intents SET generation=generation+1 WHERE recipient_user_id=$1`, [recipient]);
    expect((await db.pool.query(`SELECT generation,processed_generation FROM direct_message_notification_intents
      WHERE recipient_user_id=$1`, [recipient])).rows[0]).toEqual({ generation: '4', processed_generation: '3' });
  } finally { await db.close(); }
}, 180000);

it('0036 down refuses retained notices or pending work without loss, then safely roundtrips completed work and prior types', async () => {
  const db = new SqlHarness();
  try {
    const { recipient } = await baseline(db);
    for (const type of priorTypes) await notice(db, recipient, type);
    await db.migration(up);
    const pending = await intent(db);
    const oldNotices = (await db.pool.query('SELECT * FROM notifications ORDER BY id')).rows;
    await expect(db.migration(down)).rejects.toMatchObject({ code: 'P0001' });
    expect(await intent(db)).toEqual(pending);
    expect((await db.pool.query('SELECT * FROM notifications ORDER BY id')).rows).toEqual(oldNotices);
    await db.pool.query('UPDATE direct_message_notification_intents SET processed_generation=generation');
    const directNotice = await notice(db, recipient, 'DIRECT_MESSAGE');
    const completed = await intent(db);
    const retained = (await db.pool.query('SELECT * FROM notifications ORDER BY id')).rows;
    await expect(db.migration(down)).rejects.toMatchObject({ code: 'P0001' });
    expect(await intent(db)).toEqual(completed);
    expect((await db.pool.query('SELECT * FROM notifications ORDER BY id')).rows).toEqual(retained);
    // Remove only this synthetic notice to demonstrate an explicitly safe downgrade.
    await db.pool.query('DELETE FROM notifications WHERE id=$1', [directNotice]);
    await db.migration(down);
    const downgraded = await intent(db);
    expect(downgraded).toEqual({ conversation_id: completed.conversation_id,
      recipient_user_id: completed.recipient_user_id, generation: completed.generation, updated_at: completed.updated_at });
    expect((await db.pool.query('SELECT * FROM notifications ORDER BY id')).rows).toEqual(oldNotices);
    await expect(notice(db, recipient, 'DIRECT_MESSAGE')).rejects.toMatchObject({ code: '23514' });
    await db.migration(up);
    expect(await intent(db)).toMatchObject({ ...downgraded, processed_generation: '0', attempts: 0, available_at: expect.any(Date) });
    expect((await db.pool.query('SELECT * FROM notifications ORDER BY id')).rows).toEqual(oldNotices);
    await notice(db, recipient, 'DIRECT_MESSAGE');
  } finally { await db.close(); }
}, 180000);
