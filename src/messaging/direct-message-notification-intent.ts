import { createNotificationIntent } from '../notifications/notification.contracts';
import { createNotificationDomainEvent, mapNotificationEvent } from '../notifications/notification-event-integration';

// A stable first unread message defines the coalesced episode. Never pass the
// message itself: this boundary selects identifiers and a timestamp only.
export function directMessageNotificationIntent(conversationId: string, recipientId: string,
  firstUnread: { id: string; createdAt: string }) {
  const event = createNotificationDomainEvent({
    eventId: firstUnread.id, eventType: 'messaging.direct.unread',
    aggregateType: 'DIRECT_CONVERSATION', aggregateId: conversationId,
    actor: { kind: 'SYSTEM', code: 'DIRECT_MESSAGE' }, recipientUserId: recipientId,
    occurredAt: firstUnread.createdAt,
    idempotencyKey: `messaging.direct.unread:${conversationId}:${recipientId}:${firstUnread.id}`,
    target: { kind: 'DIRECT_CONVERSATION', id: conversationId,
      path: `/exchange/conversations/${conversationId}` }, variables: {},
  });
  return createNotificationIntent({ event, ...mapNotificationEvent(event),
    actor: { kind: 'SYSTEM', label: 'System' } });
}
