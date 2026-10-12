import { describe, expect, it, jest } from '@jest/globals';
import type { Pool, PoolClient } from 'pg';
import { DirectMessageNotificationWorker } from './direct-message-notification-worker';
import { createNotificationRecord, type NotificationIntentClaim } from '../notifications/notification.repository';
import { directMessageNotificationIntent } from './direct-message-notification-intent';
import type { DirectConversationRow } from './direct-conversation.types';

const room = '11111111-1111-4111-8111-111111111111';
const recipient = '22222222-2222-4222-8222-222222222222';
const first = { id: '33333333-3333-4333-8333-333333333333', createdAt: '2026-10-10T01:00:00.000Z' };

function harness(outcome: 'CREATED' | 'REPLAYED' | 'CONFLICT' = 'CREATED') {
  const order: string[] = [];
  const candidate = { conversation_id: room, recipient_user_id: recipient, generation: '2' };
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('FROM direct_message_notification_intents')) return { rows: [{ ...candidate, processed_generation: '0' }] };
    if (sql.includes('FROM direct_messages')) return { rows: [{ id: first.id, created_at: new Date(first.createdAt) }] };
    if (sql.includes('notification_preferences')) return { rows: [] };
    order.push('ack'); return { rows: [] };
  });
  const client = { query } as unknown as PoolClient;
  const poolQuery = jest.fn(async () => ({ rows: [candidate] }));
  const pool = { query: poolQuery } as unknown as Pool;
  const row = { id: room, participant_a_id: recipient, last_read_a: '0', last_read_b: '0' } as DirectConversationRow;
  const conversations = { withConversation: async <T>(_actor: string, _id: string,
    operation: (client: PoolClient, row: DirectConversationRow) => Promise<T>) => {
    const result = await operation(client, row); order.push('commit'); return result;
  } };
  const notifications = { claimIntentOnClient: jest.fn(async (): Promise<NotificationIntentClaim> => {
    order.push('claim');
    if (outcome === 'CONFLICT') return { outcome, code: 'NOTIFICATION_IDEMPOTENCY_CONFLICT', deduplicationKey: 'synthetic' };
    return { outcome, record: createNotificationRecord(directMessageNotificationIntent(room, recipient, first)) };
  }) };
  const realtime = { publish: jest.fn(() => { order.push('publish'); }) };
  const worker = new DirectMessageNotificationWorker(pool, conversations, notifications, realtime);
  return { worker, order, notifications, realtime, poolQuery, query };
}

describe('durable direct-message notification worker', () => {
  it('claims and acknowledges together before publishing a local hint', async () => {
    const h = harness();
    expect(await h.worker.runOnce()).toEqual({ processed: 1, failed: 0 });
    expect(h.order).toEqual(['claim', 'ack', 'commit', 'publish']);
  });

  it('preserves existing notification READ state on replay and sends no duplicate hint', async () => {
    const h = harness('REPLAYED');
    expect(await h.worker.runOnce()).toEqual({ processed: 1, failed: 0 });
    expect(h.order).toEqual(['claim', 'ack', 'commit']);
    expect(h.realtime.publish).not.toHaveBeenCalled();
  });

  it('does not acknowledge conflicts and schedules a bounded retry instead', async () => {
    const h = harness('CONFLICT');
    expect(await h.worker.runOnce()).toEqual({ processed: 0, failed: 1 });
    expect(h.order).toEqual(['claim']);
    expect(h.poolQuery).toHaveBeenCalledTimes(2);
    expect(h.realtime.publish).not.toHaveBeenCalled();
  });

  it('shares one in-flight batch and stops draining after shutdown', async () => {
    const h = harness();
    const firstRun = h.worker.runOnce();
    expect(h.worker.runOnce()).toBe(firstRun);
    await firstRun; await h.worker.onModuleDestroy();
    expect(await h.worker.runOnce()).toEqual({ processed: 0, failed: 0 });
    expect(h.poolQuery).toHaveBeenCalledTimes(1);
  });

  it('backs off the locked generation when the candidate advanced before processing', async () => {
    const h = harness('CONFLICT');
    h.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM direct_message_notification_intents')) return { rows: [{
        conversation_id: room, recipient_user_id: recipient, generation: '3', processed_generation: '2',
      }] };
      if (sql.includes('FROM direct_messages')) return { rows: [{ id: first.id, created_at: new Date(first.createdAt) }] };
      return { rows: [] };
    });
    await h.worker.runOnce();
    expect(h.poolQuery.mock.calls.at(-1)).toEqual([expect.stringContaining('SET attempts='), [room, recipient, '3']]);
  });
});
