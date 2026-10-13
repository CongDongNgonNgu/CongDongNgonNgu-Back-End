import { describe, expect, it, jest } from '@jest/globals';
import { InMemoryCommunityRepository } from './community.repository';
import { CommunityService } from './community.service';
import { CommunityRateLimiter } from './community.rate-limiter';
import { InMemoryIdentityRepository } from '../identity/identity.repository';
import { InMemoryProfileRepository } from '../profile/profile.repository';
import { encodeCommunityCursor } from './community.pagination';
async function fixture() {
  const repository = new InMemoryCommunityRepository(),
    identities = new InMemoryIdentityRepository();
  const user = await identities.createUser({
    email: 'search@example.invalid',
    displayName: 'Synthetic search actor',
    passwordHash: null,
    status: 'ACTIVE',
    emailVerifiedAt: new Date(),
  });
  const other = await identities.createUser({
    email: 'other@example.invalid',
    displayName: 'Synthetic other',
    passwordHash: null,
    status: 'ACTIVE',
    emailVerifiedAt: new Date(),
  });
  const service = new CommunityService(
    repository,
    new InMemoryProfileRepository(),
    identities,
    new CommunityRateLimiter(),
  );
  const create = (author = user.id, time = new Date()) =>
    repository.createPost({
      authorUserId: author,
      targetLanguageCode: 'en',
      postType: 'QUESTION',
      content: 'Search target',
      topic: 'grammar',
      cefrLevel: null,
      visibility: 'PUBLIC',
      createdAt: time,
    });
  return { repository, identities, user, other, service, create };
}
describe('Community search service authorization and continuation', () => {
  it('requires an active verified actor for combined saved search and binds saved cursors to that actor', async () => {
    const f = await fixture();
    const first = await f.create(),
      second = await f.create();
    for (const row of [first, second])
      await f.repository.savePost(f.user.id, row.id, new Date());
    await expect(
      f.service.listPosts({ savedByMe: 'true' }),
    ).rejects.toMatchObject({ code: 'COMMUNITY_AUTH_REQUIRED' });
    const page = await f.service.listPosts(
      { savedByMe: 'true', limit: 1 },
      f.user.id,
    );
    expect(page.items).toHaveLength(1);
    await expect(
      f.service.listPosts(
        { savedByMe: 'true', limit: 1, cursor: page.nextCursor! },
        f.other.id,
      ),
    ).rejects.toMatchObject({ code: 'COMMUNITY_INVALID_CURSOR' });
    await f.identities.updateUser(f.user.id, { status: 'DISABLED' });
    await expect(
      f.service.listPosts({ savedByMe: 'true' }, f.user.id),
    ).rejects.toMatchObject({ code: 'COMMUNITY_AUTHOR_UNAVAILABLE' });
  });
  it('rejects unsigned legacy feed cursors and changed normalized query scope', async () => {
    const f = await fixture();
    const first = await f.create();
    await f.create();
    await expect(
      f.service.listPosts({
        cursor: encodeCommunityCursor({
          id: first.id,
          createdAt: first.createdAt,
        }),
      }),
    ).rejects.toMatchObject({ code: 'COMMUNITY_INVALID_CURSOR' });
    const page = await f.service.listPosts({ q: 'target', limit: 1 });
    await expect(
      f.service.listPosts({
        q: 'different',
        limit: 1,
        cursor: page.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: 'COMMUNITY_INVALID_CURSOR' });
    const next = await f.service.listPosts({
      q: ' target ',
      limit: 1,
      cursor: page.nextCursor!,
    });
    expect(next.items).toHaveLength(1);
    expect(next.items[0].id).not.toBe(page.items[0].id);
  });
  it('advances bounded scan cursors across projection omissions without exposing hidden author snapshots', async () => {
    const f = await fixture();
    const expected = await f.create(
      f.user.id,
      new Date('2026-10-13T00:00:00Z'),
    );
    for (let n = 1; n <= 9; n++)
      await f.create(
        f.other.id,
        new Date(new Date('2026-10-13T00:00:00Z').getTime() + n),
      );
    await f.identities.updateUser(f.other.id, { status: 'DISABLED' });
    const first = await f.service.listPosts({ limit: 1 });
    expect(first.items).toHaveLength(0);
    expect(first.nextCursor).toBeTruthy();
    const second = await f.service.listPosts({
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(0);
    expect(second.nextCursor).toBeTruthy();
    expect(second.nextCursor).not.toBe(first.nextCursor);
    const third = await f.service.listPosts({
      limit: 1,
      cursor: second.nextCursor!,
    });
    expect(third.items.map((row) => row.id)).toEqual([expected.id]);
    expect(third.nextCursor).toBeNull();
  });
  it('projects 50 freshly joined search rows without per-item author/language/interaction queries', async () => {
    const f = await fixture();
    for (let n = 0; n < 50; n++) await f.create();
    const original = f.repository.listPosts.bind(f.repository);
    jest.spyOn(f.repository, 'listPosts').mockImplementation(async (query) => {
      const page = await original(query);
      return {
        ...page,
        items: page.items.map((row) =>
          Object.assign(row, {
            searchProjection: {
              authorDisplayName: 'Synthetic search actor',
              language: {
                code: 'en',
                slug: 'english',
                nativeName: 'English',
                englishName: 'English',
                vietnameseName: 'English',
                direction: 'ltr',
              },
              interaction: {
                helpfulCount: 0,
                commentCount: 0,
                viewerReacted: false,
                viewerSaved: false,
              },
            },
          }),
        ),
      };
    });
    const profiles = new InMemoryProfileRepository();
    const languageReads = jest.spyOn(profiles, 'findByCodes'),
      authorReads = jest.spyOn(f.identities, 'findUserById'),
      interactionReads = jest.spyOn(f.repository, 'getPostInteractionSummary');
    const service = new CommunityService(
      f.repository,
      profiles,
      f.identities,
      new CommunityRateLimiter(),
    );
    expect((await service.listPosts({ limit: 50 })).items).toHaveLength(50);
    expect(languageReads.mock.calls.length).toBeLessThanOrEqual(1);
    expect(authorReads.mock.calls.length).toBeLessThanOrEqual(1);
    expect(interactionReads.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
