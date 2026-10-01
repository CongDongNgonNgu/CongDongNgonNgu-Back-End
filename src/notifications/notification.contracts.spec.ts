import {
  InMemoryNotificationIntentRegistry,
  NotificationContractError,
  createNotificationIntent,
  deserializeNotificationDomainEvent,
  normalizeNotificationActorProjection,
  sanitizeNotificationError,
  serializeNotificationDomainEvent,
  validateNotificationDomainEvent,
  validateNotificationDeliveryAttempt,
  validateNotificationReadState,
} from './notification.contracts';
import type { NotificationDomainEvent } from './notification.contracts';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const RECIPIENT_ID = '22222222-2222-4222-8222-222222222222';
const POST_ID = '33333333-3333-4333-8333-333333333333';
const COMMENT_ID = '44444444-4444-4444-8444-444444444444';
const CORRELATION_ID = '55555555-5555-4555-8555-555555555555';

function validEvent(overrides: Partial<NotificationDomainEvent> = {}): NotificationDomainEvent {
  return {
    eventId: '66666666-6666-4666-8666-666666666666',
    eventType: 'community.comment.created',
    eventVersion: 1,
    aggregateType: 'COMMUNITY_COMMENT',
    aggregateId: COMMENT_ID,
    actor: { kind: 'USER', userId: ACTOR_ID },
    recipient: { authority: 'SOURCE_DOMAIN', userId: RECIPIENT_ID },
    occurredAt: '2026-10-01T03:00:00.000Z',
    correlationId: CORRELATION_ID,
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
    ...overrides,
  };
}

function validIntent(event: NotificationDomainEvent = validEvent()) {
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

describe('notification domain contracts', () => {
  it('accepts a versioned bounded event and round-trips it without changing identity', () => {
    const event = validateNotificationDomainEvent(validEvent());
    const decoded = deserializeNotificationDomainEvent(serializeNotificationDomainEvent(event));

    expect(decoded).toEqual(event);
    expect(decoded.eventVersion).toBe(1);
    expect(decoded.recipient).toEqual({ authority: 'SOURCE_DOMAIN', userId: RECIPIENT_ID });
    expect(decoded.payload.variables).toEqual({
      commentPreview: 'A bounded comment preview',
      targetLanguage: 'vi',
    });
  });

  it('rejects an unknown event type, unsupported version and missing identity fields', () => {
    expectContractCode(() => validateNotificationDomainEvent(validEvent({ eventType: 'unknown.event' as never })), 'UNSUPPORTED_EVENT_TYPE');
    expectContractCode(() => validateNotificationDomainEvent(validEvent({ eventVersion: 2 })), 'UNSUPPORTED_EVENT_VERSION');
    expectContractCode(() => validateNotificationDomainEvent(validEvent({ eventId: '' })), 'INVALID_EVENT');
    expectContractCode(() => validateNotificationDomainEvent(validEvent({ occurredAt: 'not-a-timestamp' })), 'INVALID_TIMESTAMP');
  });

  it('rejects nested entity dumps and sensitive or unbounded payload fields', () => {
    expectContractCode(
      () => validateNotificationDomainEvent(validEvent({
        payload: {
          target: null,
          variables: { fullUser: { id: ACTOR_ID } } as never,
        },
      })),
      'INVALID_EVENT_PAYLOAD',
    );
    expectContractCode(
      () => validateNotificationDomainEvent(validEvent({
        payload: {
          target: null,
          variables: { paymentProviderReference: 'provider-secret' },
        },
      })),
      'INVALID_EVENT_PAYLOAD',
    );
    expectContractCode(
      () => validateNotificationDomainEvent(validEvent({
        payload: {
          target: null,
          variables: { commentPreview: 'x'.repeat(257) },
        },
      })),
      'INVALID_EVENT_PAYLOAD',
    );
  });

  it('requires a source-domain recipient binding and never accepts an arbitrary recipient authority', () => {
    expectContractCode(
      () => validateNotificationDomainEvent(validEvent({
        recipient: { authority: 'CLIENT', userId: RECIPIENT_ID } as never,
      })),
      'RECIPIENT_AUTHORITY_INVALID',
    );
    expectContractCode(
      () => validateNotificationDomainEvent(validEvent({
        recipient: { authority: 'SOURCE_DOMAIN', userId: 'not-a-user' },
      })),
      'INVALID_RECIPIENT',
    );
  });

  it('keeps system, provider and deleted actors safe without requiring a human user id', () => {
    expect(normalizeNotificationActorProjection({ kind: 'SYSTEM' })).toEqual({
      kind: 'SYSTEM',
      label: 'System',
    });
    expect(normalizeNotificationActorProjection({ kind: 'PROVIDER' })).toEqual({
      kind: 'PROVIDER',
      label: 'Service',
    });
    expect(normalizeNotificationActorProjection({ kind: 'DELETED' })).toEqual({
      kind: 'DELETED',
      label: 'Deleted member',
    });
  });

  it('keeps read state separate and enforces consistent unread/read timestamps', () => {
    expect(validateNotificationReadState({
      notificationId: POST_ID,
      recipientUserId: RECIPIENT_ID,
      status: 'UNREAD',
      readAt: null,
      updatedAt: '2026-10-01T03:01:00.000Z',
    })).toMatchObject({ status: 'UNREAD', readAt: null });
    expectContractCode(() => validateNotificationReadState({
      notificationId: POST_ID,
      recipientUserId: RECIPIENT_ID,
      status: 'UNREAD',
      readAt: '2026-10-01T03:01:00.000Z',
      updatedAt: '2026-10-01T03:01:00.000Z',
    }), 'INVALID_READ_STATE');
    expectContractCode(() => validateNotificationReadState({
      notificationId: POST_ID,
      recipientUserId: RECIPIENT_ID,
      status: 'READ',
      readAt: null,
      updatedAt: '2026-10-01T03:01:00.000Z',
    }), 'INVALID_READ_STATE');
  });

  it('keeps delivery attempts channel-neutral and rejects provider-specific fields', () => {
    expect(validateNotificationDeliveryAttempt({
      id: COMMENT_ID,
      notificationId: POST_ID,
      channel: 'SSE',
      status: 'PENDING',
      attemptNumber: 1,
      failureCode: null,
      attemptedAt: null,
      nextAttemptAt: null,
    })).toMatchObject({ channel: 'SSE', status: 'PENDING' });
    expectContractCode(() => validateNotificationDeliveryAttempt({
      id: COMMENT_ID,
      notificationId: POST_ID,
      channel: 'PAYOS',
      status: 'PENDING',
      attemptNumber: 1,
      failureCode: null,
      attemptedAt: null,
      nextAttemptAt: null,
    }), 'INVALID_DELIVERY_ATTEMPT');
  });

  it('derives stable logical identity from the source event and keeps read state separate', () => {
    const first = validIntent();
    const replay = validIntent();
    const distinct = validIntent(validEvent({
      eventId: '77777777-7777-4777-8777-777777777777',
      aggregateId: POST_ID,
      idempotencyKey: 'community.comment.created:comment-555:v1',
    }));

    expect(first.intentId).toBe(replay.intentId);
    expect(first.deduplicationKey).toBe(replay.deduplicationKey);
    expect(first.sourceEvent.payloadHash).toBe(replay.sourceEvent.payloadHash);
    expect(distinct.intentId).not.toBe(first.intentId);
    expect(first).not.toHaveProperty('readAt');
    expect(first).not.toHaveProperty('deliveryAttempts');
  });

  it('detects exact replay, concurrent replay, altered payload collision and distinct legitimate events', async () => {
    const registry = new InMemoryNotificationIntentRegistry();
    const original = validIntent();
    const altered = validIntent(validEvent({
      payload: {
        target: {
          kind: 'COMMUNITY_POST',
          id: POST_ID,
          path: `/community/posts/${POST_ID}`,
        },
        variables: { commentPreview: 'altered after publication' },
      },
    }));
    const distinct = validIntent(validEvent({
      eventId: '88888888-8888-4888-8888-888888888888',
      idempotencyKey: 'community.comment.created:comment-556:v1',
    }));

    const concurrent = await Promise.all([
      Promise.resolve(registry.claim(original)),
      Promise.resolve(registry.claim(original)),
    ]);

    expect(concurrent.map((claim) => claim.outcome).sort()).toEqual(['CREATED', 'REPLAYED']);
    expect(registry.claim(altered)).toMatchObject({
      outcome: 'CONFLICT',
      code: 'NOTIFICATION_IDEMPOTENCY_CONFLICT',
    });
    expect(registry.claim(distinct)).toMatchObject({ outcome: 'CREATED' });
  });

  it('sanitizes contract errors without returning secrets, private data or stack traces', () => {
    const safe = sanitizeNotificationError(new Error('password=super-secret database://private'));

    expect(safe).toEqual({
      code: 'NOTIFICATION_CONTRACT_INVALID',
      message: 'Notification contract is invalid',
    });
    expect(JSON.stringify(safe)).not.toMatch(/super-secret|database|stack/iu);
  });
});

function expectContractCode(action: () => unknown, code: NotificationContractError['code']): void {
  try {
    action();
    throw new Error('Expected contract validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(NotificationContractError);
    expect((error as NotificationContractError).code).toBe(code);
  }
}
