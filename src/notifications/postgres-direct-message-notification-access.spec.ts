import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { Pool, PoolClient } from 'pg';
import { PostgresConnectionNotificationAccess } from './postgres-connection-notification-access';
import { PostgresDirectConversationRepository } from '../messaging/postgres-direct-conversation.repository';
import type { DirectConversationRow } from '../messaging/direct-conversation.types';
import { MessageFailure } from '../messaging/message-failure';
import { directMessageNotificationIntent } from '../messaging/direct-message-notification-intent';
import { createNotificationRecord, type NotificationRepository } from './notification.repository';

const conversationId = '11111111-1111-4111-8111-111111111111';
const recipientId = '22222222-2222-4222-8222-222222222222';
const firstId = '33333333-3333-4333-8333-333333333333';
const otherId = '44444444-4444-4444-8444-444444444444';
const record = createNotificationRecord(directMessageNotificationIntent(conversationId, recipientId,
  { id: firstId, createdAt: '2026-10-12T00:00:00.000Z' }));
const room = { id: conversationId, participant_a_id: recipientId, participant_b_id: otherId,
  last_read_a: '9007199254740993', last_read_b: '0' } as DirectConversationRow;

// Transaction authorization belongs to the real conversation repository's SQL
// suite. This boundary fake proves projection/identity/channel handling only.
function fixture(first: string | null = firstId) {
  const query = jest.fn(async (_sql: string, _values: unknown[]) => ({ rows: first ? [{ id: first }] : [] }));
  const client = { query } as unknown as PoolClient;
  const poolQuery = jest.fn(async (_sql: string, _values: unknown[]) => ({ rows: [{ count: 3 }] }));
  const pool = { query: poolQuery } as unknown as Pool;
  const locked = jest.spyOn(PostgresDirectConversationRepository.prototype, 'withConversation')
    .mockImplementation(async function<T>(_actor: string, _id: string,
      operation: (client: PoolClient, row: DirectConversationRow) => Promise<T>): Promise<T> {
      return operation(client, room);
    });
  return { access: new PostgresConnectionNotificationAccess(pool), locked, query, poolQuery };
}
afterEach(() => { jest.restoreAllMocks(); });

describe('PostgreSQL current direct-message notification projection', () => {
  it('uses the locked recipient conversation and returns a generic system actor for its first unread message', async () => {
    const h = fixture();
    expect(await h.access.resolve(record)).toEqual({ kind: 'SYSTEM', label: 'System' });
    expect(h.locked).toHaveBeenCalledWith(recipientId, conversationId, expect.any(Function));
    expect(h.query).toHaveBeenCalledWith(expect.any(String),
      [conversationId, recipientId, room.last_read_a, 'IN_APP']);
  });

  it.each([null, otherId])('redacts when the current first unread is %s instead of the episode source', async first => {
    const h = fixture(first);
    expect(await h.access.resolve(record)).toBeNull();
  });

  it('passes the current SSE channel into the preference-filtered protected read', async () => {
    const h = fixture();
    expect(await h.access.resolve(record, 'SSE')).toEqual({ kind: 'SYSTEM', label: 'System' });
    expect(h.query).toHaveBeenCalledWith(expect.any(String),
      [conversationId, recipientId, room.last_read_a, 'SSE']);
  });

  it('uses the second participant own read marker without converting the bigint', async () => {
    const h = fixture();
    h.locked.mockImplementationOnce(async function<T>(_actor: string, _id: string,
      operation: (client: PoolClient, row: DirectConversationRow) => Promise<T>): Promise<T> {
      return operation({ query: h.query } as unknown as PoolClient,
        { ...room, participant_a_id: otherId, participant_b_id: recipientId,
          last_read_a: '0', last_read_b: '9007199254740995' });
    });
    expect(await h.access.resolve(record)).toEqual({ kind: 'SYSTEM', label: 'System' });
    expect(h.query).toHaveBeenCalledWith(expect.any(String),
      [conversationId, recipientId, '9007199254740995', 'IN_APP']);
  });

  it('fails closed for a wrong target kind or malformed conversation without a database read', async () => {
    const h = fixture();
    expect(await h.access.resolve({ ...record, target: { kind: 'SYSTEM', id: conversationId, path: null } })).toBeNull();
    expect(await h.access.resolve({ ...record, target: { kind: 'DIRECT_CONVERSATION', id: 'invalid', path: null } })).toBeNull();
    expect(h.locked).not.toHaveBeenCalled();
    expect(h.poolQuery).not.toHaveBeenCalled();
  });

  it('redacts current pair denial while propagating infrastructure failure', async () => {
    const h = fixture();
    h.locked.mockRejectedValueOnce(new MessageFailure('CONVERSATION_UNAVAILABLE', 404, 'Unavailable'));
    expect(await h.access.resolve(record)).toBeNull();
    h.locked.mockRejectedValueOnce(new Error('Synthetic persistence failure'));
    await expect(h.access.resolve(record)).rejects.toThrow('Synthetic persistence failure');
  });

  it('counts in a single database query without scanning repository pages', async () => {
    const h = fixture();
    expect(await h.access.countUnread(recipientId, {} as NotificationRepository)).toBe(3);
    expect(h.poolQuery).toHaveBeenCalledTimes(1);
    expect(h.poolQuery).toHaveBeenCalledWith(expect.stringContaining('direct_conversations'), [recipientId]);
  });
});
