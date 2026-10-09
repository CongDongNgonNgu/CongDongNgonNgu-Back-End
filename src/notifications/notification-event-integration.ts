import { Inject, Injectable } from '@nestjs/common';
import type { IdentityRepository } from '../identity/identity.repository';
import { IDENTITY_REPOSITORY } from '../identity/identity.module';
import {
  createNotificationIntent,
  validateNotificationDomainEvent,
  type NotificationActorProjection,
  type NotificationCategory,
  type NotificationDomainEvent,
  type NotificationEventActor,
  type NotificationPriority,
  type NotificationRetentionPolicy,
  type NotificationType,
} from './notification.contracts';
import { NotificationPreferenceService } from './notification-preference.service';
import type { NotificationIntentClaim } from './notification.repository';
import { NotificationService } from './notification.service';

export const NOTIFICATION_DOMAIN_EVENT_SINK = 'NOTIFICATION_DOMAIN_EVENT_SINK';

export interface NotificationDomainEventSink {
  publish(event: NotificationDomainEvent): Promise<NotificationPublishResult>;
}

export type NotificationPublishResult = NotificationIntentClaim | {
  readonly outcome: 'SUPPRESSED';
  readonly reason: 'IN_APP_PREFERENCE';
  readonly eventId: string;
};

export interface CreateNotificationDomainEventInput {
  readonly eventId: string;
  readonly eventType: NotificationDomainEvent['eventType'];
  readonly aggregateType: NotificationDomainEvent['aggregateType'];
  readonly aggregateId: string;
  readonly actor: NotificationEventActor | null;
  readonly recipientUserId: string;
  readonly occurredAt: Date | string;
  readonly idempotencyKey: string;
  readonly target: NotificationDomainEvent['payload']['target'];
  readonly variables: NotificationDomainEvent['payload']['variables'];
  readonly correlationId?: string;
  readonly causationId?: string | null;
}

export function createNotificationDomainEvent(
  input: CreateNotificationDomainEventInput,
): NotificationDomainEvent {
  const occurredAt = input.occurredAt instanceof Date
    ? input.occurredAt.toISOString()
    : input.occurredAt;
  return validateNotificationDomainEvent({
    eventId: input.eventId,
    eventType: input.eventType,
    eventVersion: 1,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    actor: input.actor,
    recipient: {
      authority: 'SOURCE_DOMAIN',
      userId: input.recipientUserId,
    },
    occurredAt,
    correlationId: input.correlationId ?? input.eventId,
    causationId: input.causationId ?? null,
    idempotencyKey: input.idempotencyKey,
    payload: {
      target: input.target,
      variables: input.variables,
    },
  });
}

@Injectable()
export class NotificationDomainEventIntegrationService implements NotificationDomainEventSink {
  constructor(
    private readonly notifications: NotificationService,
    private readonly preferences: NotificationPreferenceService,
    @Inject(IDENTITY_REPOSITORY)
    private readonly identities: IdentityRepository,
  ) {}

  async publish(event: NotificationDomainEvent): Promise<NotificationPublishResult> {
    const validated = validateNotificationDomainEvent(event);
    const mapping = mapNotificationEvent(validated);
    const actor = await this.projectActor(validated.actor);
    const intent = createNotificationIntent({
      event: validated,
      notificationType: mapping.notificationType,
      category: mapping.category,
      priority: mapping.priority,
      actor,
      retention: mapping.retention,
    });
    const inAppEnabled = await this.preferences.isChannelEnabled(validated.recipient.userId, {
      category: mapping.category,
      channel: 'IN_APP',
      notificationType: mapping.notificationType,
    });
    if (!inAppEnabled) {
      return {
        outcome: 'SUPPRESSED',
        reason: 'IN_APP_PREFERENCE',
        eventId: validated.eventId,
      };
    }
    return this.notifications.publish(intent, new Date(validated.occurredAt));
  }

  private async projectActor(actor: NotificationEventActor | null): Promise<NotificationActorProjection> {
    if (!actor || actor.kind === 'SYSTEM') return { kind: 'SYSTEM', label: 'System' };
    if (actor.kind === 'PROVIDER') return { kind: 'PROVIDER', label: 'Service' };
    const user = await this.identities.findUserById(actor.userId);
    if (!user || user.status !== 'ACTIVE' || !user.emailVerifiedAt) {
      return { kind: 'DELETED', label: 'Deleted member' };
    }
    return {
      kind: 'USER',
      displayName: user.displayName,
      profilePath: `/profiles/${user.id}`,
    };
  }
}

export class NoopNotificationDomainEventSink implements NotificationDomainEventSink {
  async publish(_event: NotificationDomainEvent): Promise<NotificationPublishResult> {
    return { outcome: 'SUPPRESSED', reason: 'IN_APP_PREFERENCE', eventId: _event.eventId };
  }
}

interface NotificationEventMapping {
  readonly notificationType: NotificationType;
  readonly category: NotificationCategory;
  readonly priority: NotificationPriority;
  readonly retention: NotificationRetentionPolicy;
}

export function mapNotificationEvent(event: NotificationDomainEvent): NotificationEventMapping {
  switch (event.eventType) {
    case 'community.comment.created':
      assertAggregate(event, 'COMMUNITY_COMMENT');
      return {
        notificationType: 'COMMENT_REPLY',
        category: 'COMMUNITY',
        priority: 'NORMAL',
        retention: { mode: 'DAYS', days: 180 },
      };
    case 'community.response.accepted':
      assertAggregate(event, 'CORRECTION_RESPONSE');
      return {
        notificationType: responseNotificationType(event),
        category: 'CORRECTIONS',
        priority: 'HIGH',
        retention: { mode: 'DAYS', days: 365 },
      };
    case 'exchange.connection.requested':
    case 'exchange.connection.connected':
      assertAggregate(event, 'EXCHANGE_CONNECTION');
      return {
        notificationType: event.eventType==='exchange.connection.connected'?'BUDDY_CONNECTED':'BUDDY_REQUEST',
        category: 'EXCHANGE',
        priority: 'NORMAL',
        retention: { mode: 'UNTIL_READ', maxDays: 180 },
      };
    case 'reputation.milestone.achieved':
      assertAggregate(event, 'REPUTATION_MILESTONE');
      return {
        notificationType: 'REPUTATION_MILESTONE',
        category: 'REPUTATION',
        priority: 'NORMAL',
        retention: { mode: 'INDEFINITE' },
      };
    case 'membership.subscription.activated':
    case 'membership.subscription.expired':
      assertAggregate(event, 'MEMBERSHIP_SUBSCRIPTION');
      return {
        notificationType: 'MEMBERSHIP_STATE',
        category: 'MEMBERSHIP',
        priority: 'HIGH',
        retention: { mode: 'INDEFINITE' },
      };
    case 'membership.payment.fulfilled':
      assertAggregate(event, 'MEMBERSHIP_SUBSCRIPTION');
      return {
        notificationType: 'PAYMENT_STATE',
        category: 'MEMBERSHIP',
        priority: 'HIGH',
        retention: { mode: 'INDEFINITE' },
      };
    case 'moderation.notice.created':
      assertAggregate(event, 'SYSTEM');
      return {
        notificationType: 'MODERATION_NOTICE',
        category: 'MODERATION',
        priority: 'HIGH',
        retention: { mode: 'DAYS', days: 365 },
      };
  }
}

function responseNotificationType(event: NotificationDomainEvent): 'CORRECTION_ACCEPTED' | 'ANSWER_ACCEPTED' {
  const responseKind = event.payload.variables.responseKind;
  if (responseKind === 'CORRECTION_PROPOSAL') return 'CORRECTION_ACCEPTED';
  if (responseKind === 'QA_ANSWER') return 'ANSWER_ACCEPTED';
  throw new Error('Notification response event mapping is invalid');
}

function assertAggregate(
  event: NotificationDomainEvent,
  expected: NotificationDomainEvent['aggregateType'],
): void {
  if (event.aggregateType !== expected) throw new Error('Notification event aggregate mapping is invalid');
}
