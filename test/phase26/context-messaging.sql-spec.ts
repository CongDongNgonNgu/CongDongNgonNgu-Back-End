import { randomUUID } from 'node:crypto';
import { SqlHarness } from '../phase22/sql-harness';
import { PostgresDirectConversationRepository } from '../../src/messaging/postgres-direct-conversation.repository';
import { PostgresDirectMessageRepository } from '../../src/messaging/postgres-direct-message.repository';
import { MessageCursorCodec } from '../../src/messaging/message-cursor';
import { MessageContextResolver } from '../../src/messaging/message-context-resolver';
import type { LibraryPublicResource } from '../../src/library/library.types';

describe('Phase26 context send and current history SQL integration', () => {
  const db = new SqlHarness();
  beforeAll(async () => {
    await db.open();
    for (const file of ['0002_language_profile.sql', '0006_language_exchange_preferences.sql',
      '0007_language_exchange_connections.sql', '0008_language_exchange_safety.sql',
      '0032_phase26_direct_messaging.sql', '0033_phase26_message_intents_limits.sql',
      '0035_phase26_message_context.sql']) await db.migration(file);
  });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => { await db.reset(); });

  async function fixture() {
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()].sort();
    const language = (await db.pool.query(`INSERT INTO languages(code,slug,native_name,english_name,vietnamese_name)
      VALUES('en','english','English','English','English') ON CONFLICT(code) DO UPDATE SET active=true RETURNING id`)).rows[0].id;
    for (const id of [a, b, c]) {
      await db.pool.query(`INSERT INTO users(id,email,normalized_email,display_name,status,email_verified_at)
        VALUES($1,$2,$2,'Synthetic context actor','ACTIVE',now())`, [id, id + '@phase26.invalid']);
      await db.pool.query(`INSERT INTO language_exchange_preferences(user_id,exchange_opt_in,discoverable,contact_permission)
        VALUES($1,true,true,'RELATIONSHIP_GATED')`, [id]);
      const relation = (await db.pool.query(`INSERT INTO user_languages(user_id,language_id,is_known,is_learning,declared_proficiency)
        VALUES($1,$2,true,true,'B1') RETURNING id`, [id, language])).rows[0].id;
      await db.pool.query(`INSERT INTO language_exchange_languages(user_id,user_language_id,direction)
        VALUES($1,$2,'OFFER'),($1,$2,'WANT')`, [id, relation]);
    }
    await db.pool.query(`INSERT INTO language_exchange_connections(participant_a_id,participant_b_id,requester_id,status)
      VALUES($1,$2,$1,'CONNECTED')`, [a, b]);
    const target = randomUUID();let available = true;
    // Canonical service port is a boundary fake; SQL proof covers messaging,
    // not the Library domain's own provenance/license eligibility implementation.
    const library = { getPublicResource: jest.fn(async (id: string) => available && id === target ? {
      id: target, resourceType: 'VOCABULARY', primaryLanguageCode: 'en',
      details: { resourceType: 'VOCABULARY', term: 'Current public word', definition: 'Definition' },
    } as LibraryPublicResource : null) };
    const resolver = new MessageContextResolver(library, { getPost: jest.fn() });
    const cursors = new MessageCursorCodec('synthetic-context-messaging-secret');
    const conversations = new PostgresDirectConversationRepository(db.pool, cursors);
    const messages = new PostgresDirectMessageRepository(db.pool, conversations, cursors, resolver);
    const room = await conversations.open(a, b);
    const payload = { clientMessageId: randomUUID(), contextType: 'LIBRARY_RESOURCE', contextId: target };
    return { a, b, c, room, messages, payload, library, revoke: () => { available = false; } };
  }

  it('persists only canonical reference and optional note through the existing send transaction', async () => {
    const { a, b, room, messages, payload } = await fixture();
    const contextOnly = await messages.send(a, room.id, payload);
    const noted = await messages.send(b, room.id, { ...payload, clientMessageId: randomUUID(), text: ' Explain? ' });
    expect(contextOnly.text).toBe('');expect(noted.text).toBe('Explain?');
    expect([contextOnly.sequence, noted.sequence]).toEqual(['1', '2']);
    expect(contextOnly.context).toMatchObject({ availability: 'AVAILABLE', id: payload.contextId });
    expect((await db.pool.query('SELECT text,context_type,context_id FROM direct_messages ORDER BY sequence')).rows)
      .toEqual([{ text: '', context_type: 'LIBRARY_RESOURCE', context_id: payload.contextId },
        { text: 'Explain?', context_type: 'LIBRARY_RESOURCE', context_id: payload.contextId }]);
  });

  it('retries a committed revoked context without mutation or stale metadata; changed payload conflicts', async () => {
    const { a, room, messages, payload, revoke } = await fixture();
    const first = await messages.send(a, room.id, payload);
    const before = (await db.pool.query(`SELECT next_sequence,change_version,
      (SELECT sum(hits) FROM direct_message_rate_limits) AS hits,
      (SELECT sum(generation) FROM direct_message_notification_intents) AS generation FROM direct_conversations`)).rows;
    revoke();
    const retry = await messages.send(a, room.id, payload);
    expect(retry.id).toBe(first.id);expect(retry.context).toEqual({ availability: 'UNAVAILABLE' });
    expect((await db.pool.query(`SELECT next_sequence,change_version,
      (SELECT sum(hits) FROM direct_message_rate_limits) AS hits,
      (SELECT sum(generation) FROM direct_message_notification_intents) AS generation FROM direct_conversations`)).rows).toEqual(before);
    for (const change of [{ text: 'changed' }, { contextId: randomUUID() }, { contextType: 'COMMUNITY_POST' }])
      await expect(messages.send(a, room.id, { ...payload, ...change })).rejects.toMatchObject({ code: 'MESSAGE_IDEMPOTENCY_CONFLICT' });
  });

  it('denies new unavailable contexts without budget, message, sequence or intent mutation', async () => {
    const { a, room, messages, payload, revoke } = await fixture();revoke();
    await expect(messages.send(a, room.id, payload)).rejects.toMatchObject({ code: 'MESSAGE_CONTEXT_UNAVAILABLE' });
    for (const table of ['direct_messages', 'direct_message_rate_limits', 'direct_message_notification_intents'])
      expect(Number((await db.pool.query('SELECT count(*) FROM ' + table)).rows[0].count)).toBe(0);
    expect((await db.pool.query('SELECT next_sequence,change_version FROM direct_conversations')).rows)
      .toEqual([{ next_sequence: '1', change_version: '0' }]);
  });

  it('fails closed when a context resolver is absent for new shares, retries and history', async () => {
    const { a, b, room, messages, payload } = await fixture();
    const cursors = new MessageCursorCodec('synthetic-context-messaging-secret');
    const conversations = new PostgresDirectConversationRepository(db.pool, cursors);
    const unconfigured = new PostgresDirectMessageRepository(db.pool, conversations, cursors);
    await expect(unconfigured.send(a, room.id, payload)).rejects.toThrow('Messaging context resolver is required');
    const first = await messages.send(a, room.id, payload);
    await expect(unconfigured.send(a, room.id, payload)).rejects.toThrow('Messaging context resolver is required');
    await expect(unconfigured.history(b, room.id, {})).rejects.toThrow('Messaging context resolver is required');
    expect((await db.pool.query('SELECT id FROM direct_messages')).rows).toEqual([{ id: first.id }]);
    expect((await db.pool.query('SELECT next_sequence,change_version FROM direct_conversations')).rows)
      .toEqual([{ next_sequence: '2', change_version: '1' }]);
  });

  it('reauthorizes history live, deduplicates current references, and denies C before target resolution', async () => {
    const { a, b, c, room, messages, payload, revoke, library } = await fixture();
    await messages.send(a, room.id, payload);
    await messages.send(a, room.id, { ...payload, clientMessageId: randomUUID(), text: 'note' });
    library.getPublicResource.mockClear();
    expect((await messages.history(b, room.id, {})).items.every(m => m.context?.availability === 'AVAILABLE')).toBe(true);
    expect(library.getPublicResource).toHaveBeenCalledTimes(1);revoke();
    expect((await messages.history(b, room.id, {})).items.map(m => m.context))
      .toEqual([{ availability: 'UNAVAILABLE' }, { availability: 'UNAVAILABLE' }]);
    library.getPublicResource.mockClear();
    await expect(messages.history(c, room.id, {})).rejects.toMatchObject({ code: 'CONVERSATION_UNAVAILABLE' });
    await expect(messages.send(c, room.id, payload)).rejects.toMatchObject({ code: 'CONVERSATION_UNAVAILABLE' });
    expect(library.getPublicResource).not.toHaveBeenCalled();
  });
});
