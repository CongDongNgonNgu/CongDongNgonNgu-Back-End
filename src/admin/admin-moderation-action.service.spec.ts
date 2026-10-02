import { describe, expect, it } from '@jest/globals';
import { InMemoryCommunityRepository } from '../community/community.repository';
import { InMemoryIdentityRepository } from '../identity/identity.repository';
import { InMemoryLibraryRepository } from '../library/library.repository';
import { InMemoryReputationLedgerRepository } from '../reputation/reputation.repository';
import { AntiFarmingRuleEngine } from '../reputation/anti-farming.rules';
import { ContributionRuleEngine } from '../reputation/reputation.rules';
import { ReputationService } from '../reputation/reputation.service';
import { AdminModerationActionService } from './admin-moderation-action.service';

describe('AdminModerationActionService', () => {
  it('allows moderators to hide and restore content but not change user status', async () => {
    const identities = new InMemoryIdentityRepository();
    const community = new InMemoryCommunityRepository();
    const library = new InMemoryLibraryRepository();
    const reputation = new ReputationService(
      new InMemoryReputationLedgerRepository(),
      new ContributionRuleEngine(),
      new AntiFarmingRuleEngine(),
    );
    const service = new AdminModerationActionService(identities, community, library, reputation);
    const author = await identities.createUser({
      email: 'author@example.com',
      displayName: 'Author',
      passwordHash: null,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
    const post = await community.createPost({
      authorUserId: author.id,
      targetLanguageCode: 'en',
      postType: 'DISCUSSION',
      content: 'A post',
      cefrLevel: null,
      topic: null,
      visibility: 'PUBLIC',
      createdAt: new Date(),
    });

    const moderator = { userId: 'moderator-1', roles: ['MODERATOR'] as const };
    await expect(service.moderateContent(moderator, {
      targetType: 'COMMUNITY_POST',
      targetId: post.id,
      action: 'HIDE',
      reason: 'Breaks community rules',
    })).resolves.toMatchObject({ action: 'HIDE', previousState: 'ACTIVE', nextState: 'HIDDEN' });
    await expect(community.findPostById(post.id)).resolves.toMatchObject({ moderationState: 'HIDDEN' });
    await expect(service.moderateContent(moderator, {
      targetType: 'COMMUNITY_POST',
      targetId: post.id,
      action: 'RESTORE',
      reason: 'Review completed',
    })).resolves.toMatchObject({ action: 'RESTORE', nextState: 'ACTIVE' });

    const comment = await community.createComment({
      postId: post.id,
      authorUserId: author.id,
      parentCommentId: null,
      depth: 0,
      content: 'A comment',
      createdAt: new Date(),
    });
    await expect(service.moderateContent(moderator, {
      targetType: 'COMMUNITY_COMMENT',
      targetId: comment.id,
      action: 'REMOVE',
      reason: 'Targeted harassment',
    })).resolves.toMatchObject({ action: 'REMOVE', nextState: 'DELETED' });
    await expect(community.findCommentById(comment.id)).resolves.toMatchObject({ moderationState: 'DELETED' });

    const resource = await library.createResource({
      resourceType: 'VOCABULARY',
      primaryLanguageCode: 'en',
      secondaryLanguageCode: null,
      cefrLevel: null,
      topics: [],
      visibility: 'PUBLIC',
      details: { resourceType: 'VOCABULARY', term: 'word', definition: 'meaning', partOfSpeech: null, exampleSentence: null },
      createdByUserId: author.id,
      createdAt: new Date(),
    });
    await expect(service.moderateContent(moderator, {
      targetType: 'LIBRARY_RESOURCE',
      targetId: resource.id,
      action: 'HIDE',
      reason: 'Resource requires review',
    })).resolves.toMatchObject({ action: 'HIDE', nextState: 'HIDDEN' });
    await expect(library.findResourceById(resource.id)).resolves.toMatchObject({ moderationState: 'HIDDEN' });

    await expect(service.moderateUser(moderator, {
      targetUserId: author.id,
      action: 'SUSPEND',
      reason: 'Abuse confirmed',
    })).rejects.toMatchObject({ code: 'ADMIN_MODERATION_FORBIDDEN' });
  });

  it('requires ADMIN for user actions and supports explicit idempotent reputation reversal', async () => {
    const identities = new InMemoryIdentityRepository();
    const community = new InMemoryCommunityRepository();
    const library = new InMemoryLibraryRepository();
    const ledger = new InMemoryReputationLedgerRepository();
    const reputation = new ReputationService(ledger, new ContributionRuleEngine(), new AntiFarmingRuleEngine());
    const service = new AdminModerationActionService(identities, community, library, reputation);
    const user = await identities.createUser({
      email: 'user@example.com',
      displayName: 'User',
      passwordHash: null,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
    const sourceId = '11111111-1111-4111-8111-111111111111';
    const award = await ledger.append({
      userId: user.id,
      system: 'community_reputation',
      sourceType: 'RESOURCE_VERIFIED',
      sourceId,
      delta: 10,
      reason: 'Verified contribution',
      ruleVersion: 'phase-10',
      idempotencyKey: 'award:phase15:test',
      reversalOfEntryId: null,
      createdAt: new Date(),
    });
    const admin = { userId: 'admin-1', roles: ['ADMIN'] as const };

    await expect(service.moderateUser(admin, {
      targetUserId: user.id,
      action: 'WARN',
      reason: 'First warning',
    })).resolves.toMatchObject({ action: 'WARN', changed: false });
    await expect(service.moderateUser(admin, {
      targetUserId: user.id,
      action: 'SUSPEND',
      reason: 'Repeated abuse',
    })).resolves.toMatchObject({ action: 'SUSPEND', nextState: 'DISABLED' });
    await expect(identities.findUserById(user.id)).resolves.toMatchObject({ status: 'DISABLED' });
    await expect(service.moderateUser(admin, {
      targetUserId: user.id,
      action: 'RESTORE',
      reason: 'Appeal accepted',
    })).resolves.toMatchObject({ action: 'RESTORE', nextState: 'ACTIVE' });

    const firstReversal = await service.reverseReputation(admin, {
      entryId: award.entry.id,
      reason: 'Award was based on removed content',
      idempotencyKey: 'reversal:phase15:test',
    });
    const secondReversal = await service.reverseReputation(admin, {
      entryId: award.entry.id,
      reason: 'Award was based on removed content',
      idempotencyKey: 'reversal:phase15:test',
    });
    expect(firstReversal).toMatchObject({ created: true, delta: -10 });
    expect(secondReversal).toMatchObject({ created: false, delta: -10 });
  });
});
