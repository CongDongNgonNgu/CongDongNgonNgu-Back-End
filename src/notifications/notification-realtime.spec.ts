import { describe, expect, it } from '@jest/globals';
import type { NotificationDomainEvent } from './notification.contracts';
import { createNotificationIntent } from './notification.contracts';
import { InMemoryNotificationRepository } from './notification.repository';
import {
  NotificationRealtimeService,
  type NotificationRealtimeEvent,
} from './notification-realtime.service';
import { NotificationService } from './notification.service';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const POST_ID = '44444444-4444-4444-8444-444444444444';

describe('notification realtime delivery', () => {
  it('authenticates by owner at the stream boundary and broadcasts only to that owner', async () => {
    const repository = new InMemoryNotificationRepository();
    const service = new NotificationRealtimeService(repository);
    const ownerEvents: NotificationRealtimeEvent[] = [];
    const otherEvents: NotificationRealtimeEvent[] = [];
    const ownerSubscription = service.stream(USER_A).subscribe((event) => ownerEvents.push(event));
    const otherSubscription = service.stream(USER_B).subscribe((event) => otherEvents.push(event));

    const claim = await repository.claimIntent(buildIntent(USER_A));
    if (claim.outcome !== 'CREATED') throw new Error('notification setup failed');
    service.publish(claim.record);

    expect(ownerEvents.filter(isNotification)).toHaveLength(1);
    expect(otherEvents.filter(isNotification)).toHaveLength(0);
    expect(ownerEvents.find(isNotification)?.data).not.toHaveProperty('recipientUserId');
    expect(ownerEvents.find(isNotification)?.data).not.toHaveProperty('sourceEventId');

    ownerSubscription.unsubscribe();
    otherSubscription.unsubscribe();
  });

  it('replays only later canonical events owned by the reconnecting user', async () => {
    const repository = new InMemoryNotificationRepository();
    const service = new NotificationRealtimeService(repository);
    const first = await repository.claimIntent(buildIntent(USER_A, {
      eventId: '55555555-5555-4555-8555-555555555555',
      occurredAt: '2026-10-01T03:00:00.000Z',
      idempotencyKey: 'community.comment.created:replay-first:v1',
    }));
    const second = await repository.claimIntent(buildIntent(USER_A, {
      eventId: '66666666-6666-4666-8666-666666666666',
      occurredAt: '2026-10-01T04:00:00.000Z',
      idempotencyKey: 'community.comment.created:replay-second:v1',
    }));
    if (first.outcome !== 'CREATED' || second.outcome !== 'CREATED') throw new Error('notification setup failed');

    const events: NotificationRealtimeEvent[] = [];
    const subscription = service.stream(USER_A, first.record.id).subscribe((event) => events.push(event));
    await flushAsyncWork();

    expect(events.find((event) => event.type === 'ready')).toMatchObject({
      data: { protocolVersion: 1, replay: 'AVAILABLE', retryAfterMs: 1000 },
      retry: 1000,
    });
    expect(events.filter(isNotification).map((event) => event.id)).toEqual([second.record.id]);

    subscription.unsubscribe();
  });

  it('falls back without revealing whether a reconnect cursor belongs to another user', async () => {
    const repository = new InMemoryNotificationRepository();
    const service = new NotificationRealtimeService(repository);
    const claim = await repository.claimIntent(buildIntent(USER_A));
    if (claim.outcome !== 'CREATED') throw new Error('notification setup failed');

    const events: NotificationRealtimeEvent[] = [];
    const subscription = service.stream(USER_B, claim.record.id).subscribe((event) => events.push(event));
    await flushAsyncWork();

    expect(events).toContainEqual({
      type: 'replay-unavailable',
      data: {
        reason: 'LAST_EVENT_NOT_AVAILABLE',
        fallback: 'POLL_NOTIFICATIONS',
        pollPath: '/notifications',
      },
    });
    expect(events.filter(isNotification)).toHaveLength(0);
    subscription.unsubscribe();
  });

  it('deduplicates duplicate publishes while preserving multi-tab fan-out and cleans up closed tabs', async () => {
    const repository = new InMemoryNotificationRepository();
    const service = new NotificationRealtimeService(repository);
    const firstTab: NotificationRealtimeEvent[] = [];
    const secondTab: NotificationRealtimeEvent[] = [];
    const firstSubscription = service.stream(USER_A).subscribe((event) => firstTab.push(event));
    const secondSubscription = service.stream(USER_A).subscribe((event) => secondTab.push(event));

    const claim = await repository.claimIntent(buildIntent(USER_A));
    if (claim.outcome !== 'CREATED') throw new Error('notification setup failed');
    service.publish(claim.record);
    service.publish(claim.record);
    secondSubscription.unsubscribe();
    service.publish(claim.record);

    expect(firstTab.filter(isNotification)).toHaveLength(1);
    expect(secondTab.filter(isNotification)).toHaveLength(1);

    firstSubscription.unsubscribe();
  });

  it('publishes only newly-created canonical notifications from the domain service', async () => {
    const repository = new InMemoryNotificationRepository();
    const realtime = new NotificationRealtimeService(repository);
    const notifications = new NotificationService(repository, realtime);
    const events: NotificationRealtimeEvent[] = [];
    const subscription = realtime.stream(USER_A).subscribe((event) => events.push(event));
    const intent = buildIntent(USER_A);

    await notifications.publish(intent);
    await notifications.publish(intent);

    expect(events.filter(isNotification)).toHaveLength(1);
    subscription.unsubscribe();
  });

  it('rejects malformed Last-Event-ID values before opening a connection', () => {
    const service = new NotificationRealtimeService(new InMemoryNotificationRepository());

    expect(() => service.stream(USER_A, 'not-a-uuid')).toThrow('Last event id is invalid');
  });
});

function isNotification(event: NotificationRealtimeEvent): event is Extract<NotificationRealtimeEvent, { type: 'notification' }> {
  return event.type === 'notification';
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function buildIntent(
  recipientUserId: string,
  overrides: Partial<NotificationDomainEvent> = {},
) {
  const event: NotificationDomainEvent = {
    eventId: '77777777-7777-4777-8777-777777777777',
    eventType: 'community.comment.created',
    eventVersion: 1,
    aggregateType: 'COMMUNITY_COMMENT',
    aggregateId: '88888888-8888-4888-8888-888888888888',
    actor: { kind: 'USER', userId: ACTOR_ID },
    recipient: { authority: 'SOURCE_DOMAIN', userId: recipientUserId },
    occurredAt: '2026-10-01T02:00:00.000Z',
    correlationId: '99999999-9999-4999-8999-999999999999',
    causationId: null,
    idempotencyKey: 'community.comment.created:realtime-default:v1',
    payload: {
      target: { kind: 'COMMUNITY_POST', id: POST_ID, path: `/community/posts/${POST_ID}` },
      variables: { commentPreview: 'A bounded realtime notification' },
    },
    ...overrides,
  };

  return createNotificationIntent({
    event,
    notificationType: 'COMMENT_REPLY',
    category: 'COMMUNITY',
    priority: 'NORMAL',
    actor: { kind: 'USER', displayName: 'Realtime Actor', profilePath: `/profiles/${ACTOR_ID}` },
    retention: { mode: 'DAYS', days: 180 },
  });
}
