import { describe, expect, it } from '@jest/globals';
import { InMemoryIdentityRepository } from '../identity/identity.repository';
import type { UserRecord } from '../identity/identity.types';
import { InMemoryNotificationPreferenceRepository } from './notification-preference.repository';
import { NotificationPreferenceService } from './notification-preference.service';
import { InMemoryNotificationRepository } from './notification.repository';
import { NotificationRealtimeService } from './notification-realtime.service';
import { NotificationService } from './notification.service';
import {
  createNotificationDomainEvent,
  NotificationDomainEventIntegrationService,
} from './notification-event-integration';

const COMMENT_ID = '33333333-3333-4333-8333-333333333333';
const POST_ID = '44444444-4444-4444-8444-444444444444';
const CONNECTION_ID = '55555555-5555-4555-8555-555555555555';

describe('notification event integration', () => {
  it('maps accepted connections distinctly, deduplicates and honors Exchange in-app preferences',async()=>{
    const identity=new InMemoryIdentityRepository();
    const actor=await seedUser(identity,'Accepting Learner');
    const recipient=await seedUser(identity,'Requesting Learner');
    const preferences=new NotificationPreferenceService(new InMemoryNotificationPreferenceRepository());
    const repository=new InMemoryNotificationRepository();
    const integration=new NotificationDomainEventIntegrationService(new NotificationService(repository,undefined,preferences),preferences,identity);
    const event=createNotificationDomainEvent({eventId:CONNECTION_ID,eventType:'exchange.connection.connected',
      aggregateType:'EXCHANGE_CONNECTION',aggregateId:CONNECTION_ID,actor:{kind:'USER',userId:actor.id},
      recipientUserId:recipient.id,occurredAt:'2026-10-09T01:00:00.000Z',
      idempotencyKey:`exchange.connection.connected:${CONNECTION_ID}:v1`,
      target:{kind:'EXCHANGE_CONNECTION',id:CONNECTION_ID,path:'/exchange/connections'},variables:{}});
    expect(await integration.publish(event)).toMatchObject({outcome:'CREATED',record:{notificationType:'BUDDY_CONNECTED',category:'EXCHANGE'}});
    expect(await integration.publish(event)).toMatchObject({outcome:'REPLAYED'});
    await preferences.update(recipient.id,[{category:'EXCHANGE',channel:'IN_APP',enabled:false}]);
    expect(await integration.publish(event)).toMatchObject({outcome:'SUPPRESSED'});
    expect((await repository.listForUser(recipient.id,{limit:10,status:'ALL'})).items).toHaveLength(1);
  });
  it('maps a canonical source event, projects the actor and replays the exact event idempotently', async () => {
    const identity = new InMemoryIdentityRepository();
    const actor = await seedUser(identity, 'Source Learner');
    const recipient = await seedUser(identity, 'Recipient Learner');
    const preferences = new NotificationPreferenceService(new InMemoryNotificationPreferenceRepository());
    const repository = new InMemoryNotificationRepository();
    const integration = new NotificationDomainEventIntegrationService(
      new NotificationService(repository, new NotificationRealtimeService(repository), preferences),
      preferences,
      identity,
    );
    const event = commentEvent(actor.id, recipient.id);

    const first = await integration.publish(event);
    const replay = await integration.publish(event);

    expect(first).toMatchObject({ outcome: 'CREATED' });
    expect(replay).toMatchObject({ outcome: 'REPLAYED' });
    const page = await repository.listForUser(recipient.id, { limit: 10, status: 'ALL' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].record).toMatchObject({
      sourceEventId: COMMENT_ID,
      recipientUserId: recipient.id,
      notificationType: 'COMMENT_REPLY',
      actor: { kind: 'USER', displayName: 'Source Learner' },
    });
  });

  it('suppresses optional in-app noise without creating unread state, while SSE preference suppression keeps canonical state recoverable', async () => {
    const identity = new InMemoryIdentityRepository();
    const actor = await seedUser(identity, 'Source Learner');
    const recipient = await seedUser(identity, 'Recipient Learner');
    const preferenceRepository = new InMemoryNotificationPreferenceRepository();
    const preferences = new NotificationPreferenceService(preferenceRepository);
    const repository = new InMemoryNotificationRepository();
    const realtime = new NotificationRealtimeService(repository);
    const integration = new NotificationDomainEventIntegrationService(
      new NotificationService(repository, realtime, preferences),
      preferences,
      identity,
    );

    await preferences.update(recipient.id, [
      { category: 'COMMUNITY', channel: 'IN_APP', enabled: false },
    ]);
    await expect(integration.publish(commentEvent(actor.id, recipient.id))).resolves.toMatchObject({ outcome: 'SUPPRESSED' });
    await expect(repository.countUnread(recipient.id)).resolves.toBe(0);

    await preferences.update(recipient.id, [
      { category: 'EXCHANGE', channel: 'SSE', enabled: false },
    ]);
    const exchangeEvent = createNotificationDomainEvent({
      eventId: CONNECTION_ID,
      eventType: 'exchange.connection.requested',
      aggregateType: 'EXCHANGE_CONNECTION',
      aggregateId: CONNECTION_ID,
      actor: { kind: 'USER', userId: actor.id },
      recipientUserId: recipient.id,
      occurredAt: '2026-10-01T01:00:00.000Z',
      idempotencyKey: `exchange.connection.requested:${CONNECTION_ID}:v1`,
      target: { kind: 'EXCHANGE_CONNECTION', id: CONNECTION_ID, path: '/exchange' },
      variables: { relationship: 'BUDDY_REQUEST' },
    });
    await expect(integration.publish(exchangeEvent)).resolves.toMatchObject({ outcome: 'CREATED' });
    await expect(repository.countUnread(recipient.id)).resolves.toBe(1);
  });

  it('projects disabled or deleted actors safely and keeps mandatory membership notices enabled', async () => {
    const identity = new InMemoryIdentityRepository();
    const actor = await seedUser(identity, 'Former Learner');
    const recipient = await seedUser(identity, 'Recipient Learner');
    await identity.updateUser(actor.id, { status: 'DISABLED' });
    const preferenceRepository = new InMemoryNotificationPreferenceRepository();
    const preferences = new NotificationPreferenceService(preferenceRepository);
    const repository = new InMemoryNotificationRepository();
    const integration = new NotificationDomainEventIntegrationService(
      new NotificationService(repository, undefined, preferences),
      preferences,
      identity,
    );

    await expect(integration.publish(commentEvent(actor.id, recipient.id))).resolves.toMatchObject({ outcome: 'CREATED' });
    const commentPage = await repository.listForUser(recipient.id, { limit: 10, status: 'ALL' });
    expect(commentPage.items[0].record.actor).toEqual({ kind: 'DELETED', label: 'Deleted member' });

    await preferences.update(recipient.id, [
      { category: 'MEMBERSHIP', channel: 'IN_APP', enabled: true },
    ]);
    const membershipEvent = createNotificationDomainEvent({
      eventId: '66666666-6666-4666-8666-666666666666',
      eventType: 'membership.subscription.activated',
      aggregateType: 'MEMBERSHIP_SUBSCRIPTION',
      aggregateId: '66666666-6666-4666-8666-666666666666',
      actor: { kind: 'PROVIDER', code: 'PAYOS' },
      recipientUserId: recipient.id,
      occurredAt: '2026-10-01T02:00:00.000Z',
      idempotencyKey: 'membership.subscription.activated:66666666-6666-4666-8666-666666666666:v1',
      target: {
        kind: 'MEMBERSHIP_SUBSCRIPTION',
        id: '66666666-6666-4666-8666-666666666666',
        path: '/membership',
      },
      variables: { membershipState: 'ACTIVE' },
    });
    await expect(integration.publish(membershipEvent)).resolves.toMatchObject({ outcome: 'CREATED' });
    const membershipPage = await repository.listForUser(recipient.id, { limit: 10, status: 'ALL' });
    expect(membershipPage.items.map((item) => item.record.notificationType)).toEqual([
      'MEMBERSHIP_STATE',
      'COMMENT_REPLY',
    ]);
  });
});

function commentEvent(actorId: string, recipientId: string) {
  return createNotificationDomainEvent({
    eventId: COMMENT_ID,
    eventType: 'community.comment.created',
    aggregateType: 'COMMUNITY_COMMENT',
    aggregateId: COMMENT_ID,
    actor: { kind: 'USER', userId: actorId },
    recipientUserId: recipientId,
    occurredAt: '2026-10-01T00:00:00.000Z',
    idempotencyKey: `community.comment.created:${COMMENT_ID}:v1`,
    target: { kind: 'COMMUNITY_POST', id: POST_ID, path: `/community/posts/${POST_ID}` },
    variables: { commentKind: 'REPLY' },
  });
}

async function seedUser(identity: InMemoryIdentityRepository, displayName: string): Promise<UserRecord> {
  return identity.createUser({
    email: `${displayName.toLowerCase().replaceAll(' ', '.')}@example.com`,
    displayName,
    passwordHash: null,
    status: 'ACTIVE',
    emailVerifiedAt: new Date('2026-09-01T00:00:00.000Z'),
  });
}
