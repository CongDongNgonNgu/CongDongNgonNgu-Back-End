import { Injectable } from '@nestjs/common';
import type {
  ExchangeConnectionEvent,
  ExchangeConnectionEventSink,
} from './exchange-connection.types';
import {
  createNotificationDomainEvent,
  type NotificationDomainEventSink,
} from '../notifications/notification-event-integration';

export const EXCHANGE_CONNECTION_EVENT_SINK = 'EXCHANGE_CONNECTION_EVENT_SINK';

@Injectable()
export class NoopExchangeConnectionEventSink implements ExchangeConnectionEventSink {
  async publish(_event: ExchangeConnectionEvent): Promise<void> {
    // Phase 12 will attach notification delivery to this seam.
  }
}

export class NotificationExchangeConnectionEventSink implements ExchangeConnectionEventSink {
  constructor(private readonly notifications: NotificationDomainEventSink) {}

  async publish(event: ExchangeConnectionEvent): Promise<void> {
    if (event.type !== 'exchange.connection.requested' || event.actorUserId === event.targetUserId) return;
    await this.notifications.publish(createNotificationDomainEvent({
      eventId: event.connectionId,
      eventType: event.type,
      aggregateType: 'EXCHANGE_CONNECTION',
      aggregateId: event.connectionId,
      actor: { kind: 'USER', userId: event.actorUserId },
      recipientUserId: event.targetUserId,
      occurredAt: event.occurredAt,
      idempotencyKey: `${event.type}:${event.connectionId}:v1`,
      target: {
        kind: 'EXCHANGE_CONNECTION',
        id: event.connectionId,
        path: '/exchange',
      },
      variables: {
        relationship: 'BUDDY_REQUEST',
      },
    }));
  }
}
