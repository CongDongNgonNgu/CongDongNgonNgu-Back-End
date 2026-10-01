import { describe, expect, it } from '@jest/globals';
import { InMemoryIdentityRepository } from '../identity/identity.repository';
import { CommunityRateLimiter } from '../community/community.rate-limiter';
import { InMemoryCommunityRepository } from '../community/community.repository';
import { CommunityService } from '../community/community.service';
import { InMemoryProfileRepository } from '../profile/profile.repository';
import { InMemoryCorrectionsRepository } from '../corrections/corrections.repository';
import { CorrectionsService } from '../corrections/corrections.service';
import { ContributionRuleEngine } from '../reputation/reputation.rules';
import { InMemoryReputationLedgerRepository } from '../reputation/reputation.repository';
import { ReputationService } from '../reputation/reputation.service';
import { AntiFarmingRuleEngine } from '../reputation/anti-farming.rules';
import { NotificationExchangeConnectionEventSink } from '../exchange/exchange-connection.events';
import type { ExchangeConnectionEvent } from '../exchange/exchange-connection.types';
import type {
  NotificationDomainEvent,
} from './notification.contracts';
import type {
  NotificationDomainEventSink,
  NotificationPublishResult,
} from './notification-event-integration';

describe('authoritative notification producer integration', () => {
  it('derives community comment recipients from the post or parent comment, never from client input', async () => {
    const identity = new InMemoryIdentityRepository();
    const owner = await createUser(identity, 'owner@example.com', 'Post Owner');
    const commenter = await createUser(identity, 'commenter@example.com', 'Commenter');
    const replier = await createUser(identity, 'replier@example.com', 'Replier');
    const communityRepository = new InMemoryCommunityRepository();
    const sink = new RecordingNotificationSink();
    const community = new CommunityService(
      communityRepository,
      new InMemoryProfileRepository(),
      identity,
      new CommunityRateLimiter(),
      sink,
    );
    const post = await communityRepository.createPost({
      authorUserId: owner.id,
      targetLanguageCode: 'en',
      postType: 'DISCUSSION',
      content: 'A public post',
      cefrLevel: null,
      topic: null,
      visibility: 'PUBLIC',
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
    });

    const comment = await community.createComment(post.id, commenter.id, { content: 'A comment' });
    await community.createComment(post.id, replier.id, {
      content: 'A reply',
      parentCommentId: comment.id,
    });

    expect(sink.events).toHaveLength(2);
    expect(sink.events.map((event) => event.recipient.userId)).toEqual([owner.id, commenter.id]);
    expect(sink.events.every((event) => event.recipient.authority === 'SOURCE_DOMAIN')).toBe(true);
    expect(sink.events.map((event) => event.payload.variables.commentKind)).toEqual(['COMMENT', 'REPLY']);
  });

  it('publishes acceptance to the response author with a stable acceptance identity', async () => {
    const identity = new InMemoryIdentityRepository();
    const owner = await createUser(identity, 'requester@example.com', 'Requester');
    const responder = await createUser(identity, 'responder@example.com', 'Responder');
    const communityRepository = new InMemoryCommunityRepository();
    const community = new CommunityService(
      communityRepository,
      new InMemoryProfileRepository(),
      identity,
      new CommunityRateLimiter(),
    );
    const sink = new RecordingNotificationSink();
    const corrections = new CorrectionsService(
      new InMemoryCorrectionsRepository(communityRepository),
      community,
      new InMemoryProfileRepository(),
      identity,
      new CommunityRateLimiter(),
      sink,
    );
    const request = await corrections.createCorrectionRequest(owner.id, {
      languageCode: 'en',
      originalText: 'She go to school.',
      correctionIntent: 'GRAMMAR',
      visibility: 'PUBLIC',
    });
    const response = await corrections.createStructuredResponse(request.post.id, responder.id, {
      responseKind: 'CORRECTION_PROPOSAL',
      correctedText: 'She goes to school.',
    });

    await corrections.acceptStructuredResponse(request.post.id, response.id, owner.id);

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      eventType: 'community.response.accepted',
      aggregateType: 'CORRECTION_RESPONSE',
      aggregateId: response.id,
      recipient: { authority: 'SOURCE_DOMAIN', userId: responder.id },
      payload: {
        target: { kind: 'CORRECTION_RESPONSE', id: response.id, path: `/community/posts/${request.post.id}` },
        variables: { responseKind: 'CORRECTION_PROPOSAL' },
      },
    });
    expect(sink.events[0].idempotencyKey).toContain('community.response.accepted:');
  });

  it('emits one reputation milestone event only when the server-derived level changes', async () => {
    const sink = new RecordingNotificationSink();
    const service = new ReputationService(
      new InMemoryReputationLedgerRepository(),
      new ContributionRuleEngine(),
      new AntiFarmingRuleEngine(),
      sink,
    );
    const input = {
      contributorUserId: '11111111-1111-4111-8111-111111111111',
      sourceType: 'CORRECTION_ACCEPTED',
      sourceId: '22222222-2222-4222-8222-222222222222',
      actorUserId: '33333333-3333-4333-8333-333333333333',
      actorRole: 'MEMBER' as const,
      sourceVisibility: 'PUBLIC' as const,
      sourceState: 'ACTIVE' as const,
      occurredAt: new Date('2026-10-01T00:00:00.000Z'),
    };

    await service.awardContribution(input);
    await service.awardContribution({
      ...input,
      sourceId: '44444444-4444-4444-8444-444444444444',
    });

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      eventType: 'reputation.milestone.achieved',
      recipient: { userId: input.contributorUserId },
      payload: { variables: { level: 'HELPER', reputation: 5 } },
    });
  });

  it('routes only the authoritative buddy-request event to the target owner', async () => {
    const sink = new RecordingNotificationSink();
    const adapter = new NotificationExchangeConnectionEventSink(sink);
    const event: ExchangeConnectionEvent = {
      type: 'exchange.connection.requested',
      connectionId: '55555555-5555-4555-8555-555555555555',
      actorUserId: '66666666-6666-4666-8666-666666666666',
      targetUserId: '77777777-7777-4777-8777-777777777777',
      requesterUserId: '66666666-6666-4666-8666-666666666666',
      occurredAt: '2026-10-01T00:00:00.000Z',
    };

    await adapter.publish(event);

    expect(sink.events[0]).toMatchObject({
      eventType: 'exchange.connection.requested',
      aggregateType: 'EXCHANGE_CONNECTION',
      recipient: { userId: event.targetUserId },
      payload: { target: { kind: 'EXCHANGE_CONNECTION', id: event.connectionId, path: '/exchange' } },
    });
  });
});

class RecordingNotificationSink implements NotificationDomainEventSink {
  readonly events: NotificationDomainEvent[] = [];

  async publish(event: NotificationDomainEvent): Promise<NotificationPublishResult> {
    this.events.push(event);
    return { outcome: 'SUPPRESSED', reason: 'IN_APP_PREFERENCE', eventId: event.eventId };
  }
}

function createUser(
  identity: InMemoryIdentityRepository,
  email: string,
  displayName: string,
) {
  return identity.createUser({
    email,
    displayName,
    passwordHash: null,
    status: 'ACTIVE',
    emailVerifiedAt: new Date('2026-09-01T00:00:00.000Z'),
  });
}
