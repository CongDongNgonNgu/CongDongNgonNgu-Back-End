import { describe, expect, it } from '@jest/globals';
import type { NotificationDomainEvent } from './notification.contracts';
import { createNotificationIntent } from './notification.contracts';
import { InMemoryNotificationRepository } from './notification.repository';
import { NotificationService } from './notification.service';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const POST_ID = '44444444-4444-4444-8444-444444444444';

describe('notification API and read state', () => {
  it('persists canonical intents, replays exact duplicates, rejects altered collisions, and preserves distinct events', async () => {
    const repository = new InMemoryNotificationRepository();
    const original = buildIntent();
    const replay = buildIntent();
    const altered = buildIntent({
      payload: {
        target: {
          kind: 'COMMUNITY_POST',
          id: POST_ID,
          path: `/community/posts/${POST_ID}`,
        },
        variables: { commentPreview: 'altered after publication' },
      },
    });
    const distinct = buildIntent({
      eventId: '55555555-5555-4555-8555-555555555555',
      idempotencyKey: 'community.comment.created:comment-distinct:v1',
    });

    const concurrent = await Promise.all([
      repository.claimIntent(original),
      repository.claimIntent(original),
    ]);
    const created = concurrent.find((claim) => claim.outcome === 'CREATED');
    const replayed = concurrent.find((claim) => claim.outcome === 'REPLAYED');

    expect(concurrent.map((claim) => claim.outcome).sort()).toEqual(['CREATED', 'REPLAYED']);
    expect(created).toBeDefined();
    expect(replayed).toBeDefined();
    if (created?.outcome !== 'CREATED' || replayed?.outcome !== 'REPLAYED') throw new Error('claim setup failed');
    expect(replayed.record.id).toBe(created.record.id);
    expect(replayed.record.recipientUserId).toBe(USER_A);
    await expect(repository.claimIntent(replay)).resolves.toMatchObject({ outcome: 'REPLAYED' });
    await expect(repository.claimIntent(altered)).resolves.toMatchObject({
      outcome: 'CONFLICT',
      code: 'NOTIFICATION_IDEMPOTENCY_CONFLICT',
    });
    await expect(repository.claimIntent(distinct)).resolves.toMatchObject({ outcome: 'CREATED' });
  });

  it('keeps reads owner-scoped, paginates deterministically, and isolates unread counts', async () => {
    const repository = new InMemoryNotificationRepository();
    const first = await repository.claimIntent(buildIntent({
      eventId: '66666666-6666-4666-8666-666666666666',
      occurredAt: '2026-10-01T03:00:00.000Z',
      idempotencyKey: 'community.comment.created:comment-first:v1',
    }));
    const second = await repository.claimIntent(buildIntent({
      eventId: '77777777-7777-4777-8777-777777777777',
      occurredAt: '2026-10-01T02:00:00.000Z',
      idempotencyKey: 'community.comment.created:comment-second:v1',
    }));
    await repository.claimIntent(buildIntent({
      eventId: '88888888-8888-4888-8888-888888888888',
      recipientUserId: USER_B,
      occurredAt: '2026-10-01T04:00:00.000Z',
      idempotencyKey: 'community.comment.created:comment-other-user:v1',
    }));

    expect(first.outcome).toBe('CREATED');
    expect(second.outcome).toBe('CREATED');
    if (first.outcome !== 'CREATED' || second.outcome !== 'CREATED') throw new Error('claim setup failed');

    const page = await repository.listForUser(USER_A, {
      limit: 1,
      status: 'ALL',
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].record.id).toBe(first.record.id);
    expect(page.items[0].readState.status).toBe('UNREAD');
    expect(page.hasMore).toBe(true);

    const nextPage = await repository.listForUser(USER_A, {
      limit: 1,
      status: 'ALL',
      before: {
        createdAt: new Date(first.record.createdAt),
        id: first.record.id,
      },
    });
    expect(nextPage.items.map((item) => item.record.id)).toEqual([second.record.id]);
    expect(await repository.countUnread(USER_A)).toBe(2);
    expect(await repository.countUnread(USER_B)).toBe(1);
    expect(await repository.listForUser(USER_B, { limit: 20, status: 'ALL' })).toMatchObject({
      items: [expect.objectContaining({ record: expect.objectContaining({ recipientUserId: USER_B }) })],
    });
  });

  it('makes mark-one and mark-many read operations idempotent and owner-scoped', async () => {
    const repository = new InMemoryNotificationRepository();
    const first = await repository.claimIntent(buildIntent({
      eventId: '99999999-9999-4999-8999-999999999999',
      idempotencyKey: 'community.comment.created:comment-read-one:v1',
    }));
    const second = await repository.claimIntent(buildIntent({
      eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      idempotencyKey: 'community.comment.created:comment-read-many:v1',
    }));
    if (first.outcome !== 'CREATED' || second.outcome !== 'CREATED') throw new Error('claim setup failed');

    const now = new Date('2026-10-01T04:00:00.000Z');
    const marked = await repository.markRead(USER_A, first.record.id, now);
    const replayed = await repository.markRead(USER_A, first.record.id, new Date('2026-10-01T05:00:00.000Z'));

    expect(marked).toMatchObject({ status: 'READ', readAt: now.toISOString() });
    expect(replayed).toEqual(marked);
    expect(await repository.markRead(USER_B, first.record.id, now)).toBeNull();

    expect(await repository.markManyRead(USER_A, [first.record.id, second.record.id], now)).toEqual({
      updatedCount: 1,
    });
    expect(await repository.countUnread(USER_A)).toBe(0);
    expect(await repository.markManyRead(USER_A, [first.record.id, second.record.id], now)).toEqual({
      updatedCount: 0,
    });
  });

  it('projects safe API data and rejects a cursor issued to another owner', async () => {
    const repository = new InMemoryNotificationRepository();
    const service = new NotificationService(repository);
    const created = await service.publish(buildIntent());
    await service.publish(buildIntent({
      eventId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      occurredAt: '2026-10-01T02:00:00.000Z',
      idempotencyKey: 'community.comment.created:comment-cursor:v1',
    }));
    expect(created.outcome).toBe('CREATED');

    const page = await service.list(USER_A, { limit: 1 });
    expect(page.items[0]).toMatchObject({
      id: expect.any(String),
      actor: { kind: 'USER', displayName: 'Nguyen Learner', profilePath: `/profiles/${ACTOR_ID}` },
      target: { kind: 'COMMUNITY_POST', path: `/community/posts/${POST_ID}` },
      read: false,
      readAt: null,
    });
    expect(page.items[0].target).not.toHaveProperty('id');
    expect(page.items[0]).not.toHaveProperty('recipientUserId');
    expect(page.items[0]).not.toHaveProperty('sourceEventId');
    expect(page.unreadCount).toBe(2);
    expect(page.nextCursor).toEqual(expect.any(String));

    const paged = await service.list(USER_A, { limit: 1, cursor: page.nextCursor! });
    expect(paged.items).toHaveLength(1);
    await expect(service.list(USER_B, { limit: 1, cursor: page.nextCursor! })).rejects.toMatchObject({
      code: 'NOTIFICATION_INVALID_CURSOR',
    });
  });
});

function buildIntent(
  overrides: Partial<NotificationDomainEvent> & { recipientUserId?: string } = {},
) {
  const { recipientUserId = USER_A, ...eventOverrides } = overrides;
  const event: NotificationDomainEvent = {
    eventId: '66666666-6666-4666-8666-666666666666',
    eventType: 'community.comment.created',
    eventVersion: 1,
    aggregateType: 'COMMUNITY_COMMENT',
    aggregateId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    actor: { kind: 'USER', userId: ACTOR_ID },
    recipient: { authority: 'SOURCE_DOMAIN', userId: recipientUserId },
    occurredAt: '2026-10-01T03:00:00.000Z',
    correlationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    causationId: null,
    idempotencyKey: 'community.comment.created:comment-444:v1',
    payload: {
      target: {
        kind: 'COMMUNITY_POST',
        id: POST_ID,
        path: `/community/posts/${POST_ID}`,
      },
      variables: {
        commentPreview: 'A bounded comment preview',
        targetLanguage: 'vi',
      },
    },
    ...eventOverrides,
  };

  return createNotificationIntent({
    event,
    notificationType: 'COMMENT_REPLY',
    category: 'COMMUNITY',
    priority: 'NORMAL',
    actor: {
      kind: 'USER',
      displayName: 'Nguyen Learner',
      profilePath: `/profiles/${ACTOR_ID}`,
    },
    retention: { mode: 'DAYS', days: 180 },
  });
}
