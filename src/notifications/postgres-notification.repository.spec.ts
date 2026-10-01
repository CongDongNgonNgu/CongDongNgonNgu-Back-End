import { describe, expect, it, jest } from '@jest/globals';
import type { Pool } from 'pg';
import { createNotificationIntent } from './notification.contracts';
import { PostgresNotificationRepository } from './postgres-notification.repository';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const POST_ID = '33333333-3333-4333-8333-333333333333';
const NOTIFICATION_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-10-01T04:00:00.000Z');

type QueryResult = {
  rows: Array<Record<string, unknown>>;
  rowCount?: number;
};
type QueryFn = (...args: unknown[]) => Promise<QueryResult>;

describe('PostgresNotificationRepository', () => {
  it('persists a validated intent and creates a separate unread state in one transaction', async () => {
    const intent = buildIntent();
    const clientQuery = jest.fn<QueryFn>()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [notificationRow(intent)] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const connect = jest.fn<() => Promise<{ query: QueryFn; release: () => void }>>().mockResolvedValue({
      query: clientQuery,
      release: () => undefined,
    });
    const repository = new PostgresNotificationRepository({
      connect,
    } as unknown as Pool);

    const result = await repository.claimIntent(intent, NOW);

    expect(result).toMatchObject({ outcome: 'CREATED', record: { id: NOTIFICATION_ID, recipientUserId: USER_ID } });
    expect(clientQuery.mock.calls[1][0]).toContain('ON CONFLICT (deduplication_key) DO NOTHING');
    expect(clientQuery.mock.calls[1][0]).toContain('INSERT INTO notifications (');
    expect(clientQuery.mock.calls[2][0]).toContain("'UNREAD'");
    expect(clientQuery.mock.calls[3][0]).toBe('COMMIT');
  });

  it('loads only the requested owner page and keeps cursor and limit parameterized', async () => {
    const intent = buildIntent();
    const query = jest.fn<QueryFn>().mockResolvedValue({
      rows: [{
        ...notificationRow(intent),
        read_status: 'UNREAD',
        read_at: null,
        read_updated_at: NOW.toISOString(),
      }],
    });
    const repository = new PostgresNotificationRepository({ query } as unknown as Pool);

    const page = await repository.listForUser(USER_ID, { limit: 20, status: 'ALL' });

    expect(page.items[0]).toMatchObject({
      record: { id: NOTIFICATION_ID, recipientUserId: USER_ID },
      readState: { status: 'UNREAD', recipientUserId: USER_ID },
    });
    expect(query.mock.calls[0][0]).not.toContain(USER_ID);
    expect(query.mock.calls[0][1]).toEqual([USER_ID, 'ALL', 21]);
  });

  it('marks only unread rows owned by the caller and reports the affected count', async () => {
    const query = jest.fn<QueryFn>().mockResolvedValue({ rows: [{ notification_id: NOTIFICATION_ID }], rowCount: 1 });
    const repository = new PostgresNotificationRepository({ query } as unknown as Pool);

    const result = await repository.markManyRead(USER_ID, [NOTIFICATION_ID], NOW);

    expect(result).toEqual({ updatedCount: 1 });
    expect(query.mock.calls[0][0]).toContain("status = 'UNREAD'");
    expect(query.mock.calls[0][0]).toContain('ANY($2::uuid[])');
    expect(query.mock.calls[0][1]).toEqual([USER_ID, [NOTIFICATION_ID], NOW]);
  });
});

function buildIntent() {
  return createNotificationIntent({
    event: {
      eventId: '55555555-5555-4555-8555-555555555555',
      eventType: 'community.comment.created',
      eventVersion: 1,
      aggregateType: 'COMMUNITY_COMMENT',
      aggregateId: '66666666-6666-4666-8666-666666666666',
      actor: { kind: 'USER', userId: ACTOR_ID },
      recipient: { authority: 'SOURCE_DOMAIN', userId: USER_ID },
      occurredAt: '2026-10-01T03:00:00.000Z',
      correlationId: '77777777-7777-4777-8777-777777777777',
      causationId: null,
      idempotencyKey: 'community.comment.created:postgres:v1',
      payload: {
        target: { kind: 'COMMUNITY_POST', id: POST_ID, path: `/community/posts/${POST_ID}` },
        variables: { commentPreview: 'A bounded notification' },
      },
    },
    notificationType: 'COMMENT_REPLY',
    category: 'COMMUNITY',
    priority: 'NORMAL',
    actor: { kind: 'USER', displayName: 'Notification Actor', profilePath: `/profiles/${ACTOR_ID}` },
    retention: { mode: 'DAYS', days: 180 },
  });
}

function notificationRow(intent: ReturnType<typeof buildIntent>): Record<string, unknown> {
  return {
    id: NOTIFICATION_ID,
    intent_id: intent.intentId,
    deduplication_key: intent.deduplicationKey,
    source_event_id: intent.sourceEvent.eventId,
    recipient_user_id: intent.recipient.userId,
    notification_type: intent.notificationType,
    category: intent.category,
    priority: intent.priority,
    actor: intent.actor,
    target: intent.target,
    variables: intent.variables,
    retention: intent.retention,
    source_event_type: intent.sourceEvent.eventType,
    source_event_version: intent.sourceEvent.eventVersion,
    source_aggregate_type: intent.sourceEvent.aggregateType,
    source_aggregate_id: intent.sourceEvent.aggregateId,
    source_idempotency_key: intent.sourceEvent.idempotencyKey,
    source_payload_hash: intent.sourceEvent.payloadHash,
    intent_fingerprint: '0'.repeat(64),
    created_at: intent.createdAt,
  };
}
