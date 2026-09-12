import { InMemoryIdentityRepository } from '../identity/identity.repository';
import { InMemoryProfileRepository } from '../profile/profile.repository';
import { CommunityRateLimiter } from './community.rate-limiter';
import { InMemoryCommunityRepository } from './community.repository';
import { CommunityService } from './community.service';

describe('CommunityService reaction concurrency', () => {
  it('keeps concurrent duplicate helpful reactions idempotent at the service/repository boundary', async () => {
    const repository = new InMemoryCommunityRepository();
    const profiles = new InMemoryProfileRepository();
    const identities = new InMemoryIdentityRepository();
    const rateLimiter = new CommunityRateLimiter();
    const community = new CommunityService(repository, profiles, identities, rateLimiter);
    const user = await identities.createUser({
      email: 'reaction-concurrency@example.com',
      displayName: 'Reaction Concurrency',
      passwordHash: null,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
    const post = await repository.createPost({
      authorUserId: user.id,
      targetLanguageCode: 'en',
      postType: 'DISCUSSION',
      content: 'Concurrent reaction post',
      cefrLevel: null,
      topic: null,
      visibility: 'PUBLIC',
      createdAt: new Date(),
    });

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => community.addReaction(post.id, user.id, { type: 'HELPFUL' })),
    );

    expect(responses).toHaveLength(8);
    for (const response of responses) {
      expect(response).toEqual({
        postId: post.id,
        type: 'HELPFUL',
        reacted: true,
        helpfulCount: 1,
      });
    }
    await expect(repository.getPostInteractionSummary(post.id, user.id)).resolves.toMatchObject({
      helpfulCount: 1,
      viewerReacted: true,
    });

    await expect(community.removeReaction(post.id, user.id, 'HELPFUL')).resolves.toEqual({
      postId: post.id,
      type: 'HELPFUL',
      reacted: false,
      helpfulCount: 0,
    });
    await expect(repository.getPostInteractionSummary(post.id, user.id)).resolves.toMatchObject({
      helpfulCount: 0,
      viewerReacted: false,
    });
  });
});
