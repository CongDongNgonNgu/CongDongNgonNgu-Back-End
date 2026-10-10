import { randomUUID } from 'node:crypto';
import { InMemoryIdentityRepository } from '../identity/identity.repository';
import { InMemoryProfileRepository } from '../profile/profile.repository';
import { InMemoryLibraryRepository } from '../library/library.repository';
import { LibraryService } from '../library/library.service';
import type { LibraryActor, LibraryLicenseInput } from '../library/library.types';
import { InMemoryCommunityRepository } from '../community/community.repository';
import { CommunityService } from '../community/community.service';
import { CommunityRateLimiter } from '../community/community.rate-limiter';
import { MessageContextResolver } from './message-context-resolver';

// Real canonical services over deterministic in-memory repositories. Persistence,
// pair authorization and races are covered separately by the PostgreSQL suites.
function fixture() {
  const profiles = new InMemoryProfileRepository();
  const identities = new InMemoryIdentityRepository();
  const posts = new InMemoryCommunityRepository();
  const library = new LibraryService(new InMemoryLibraryRepository(), profiles, { findLibraryCandidateById: async () => null });
  const community = new CommunityService(posts, profiles, identities, new CommunityRateLimiter());
  return { profiles, identities, posts, library, resolver: new MessageContextResolver(library, community) };
}
const owner: LibraryActor = { userId: randomUUID(), roles: ['MEMBER'] };
const reviewer: LibraryActor = { userId: randomUUID(), roles: ['MODERATOR'] };
const license: LibraryLicenseInput = { licenseKey: 'CONTEXT-V1', displayName: 'Context synthetic license',
  canonicalUrl: 'https://phase26.invalid/license', attributionRequired: true, redistributionAllowed: true, active: true };

async function publicResource(library: LibraryService, resourceType: 'VOCABULARY' | 'SENTENCE') {
  await library.registerLicense(reviewer, license);
  const resource = await library.createDraftResource(owner, { resourceType, primaryLanguageCode: 'en', visibility: 'PUBLIC',
    details: resourceType === 'VOCABULARY' ? { term: 'Current term', definition: 'Synthetic definition' } : { text: 'Current sentence.' } });
  await library.attachProvenance(owner, resource.id, { sourceType: 'ORIGINAL_AUTHOR', sourceId: randomUUID(),
    licenseKey: license.licenseKey, attribution: 'Synthetic attribution' });
  await library.submitContribution(owner, resource.id, { termsVersion: 'library-contribution-v1', rightsConfirmed: true, reuseConsent: true });
  await library.transitionReview(reviewer, resource.id, 'VERIFIED');
  return resource;
}

describe('message context canonical-domain integration', () => {
  it.each(['VOCABULARY', 'SENTENCE'] as const)('uses current public %s and removes rejected content', async type => {
    const { library, resolver } = fixture();const resource = await publicResource(library, type);
    const reference = { type: 'LIBRARY_RESOURCE' as const, id: resource.id };
    expect(await resolver.resolve(owner.userId, reference)).toMatchObject({ availability: 'AVAILABLE', category: type,
      id: resource.id, canonicalPath: '/library/' + resource.id,
      previewText: type === 'VOCABULARY' ? 'Current term' : 'Current sentence.' });
    await library.transitionReview(reviewer, resource.id, 'REJECTED', 'Synthetic source withdrawal');
    expect(await resolver.resolve(reviewer.userId, reference)).toEqual({ availability: 'UNAVAILABLE' });
  });

  it.each([{ active: false, redistributionAllowed: true }, { active: true, redistributionAllowed: false },
    { active: true, redistributionAllowed: null }])('rechecks current license $active/$redistributionAllowed', async change => {
    const { library, resolver } = fixture();const resource = await publicResource(library, 'VOCABULARY');
    const reference = { type: 'LIBRARY_RESOURCE' as const, id: resource.id };
    expect((await resolver.resolve(owner.userId, reference)).availability).toBe('AVAILABLE');
    await library.registerLicense(reviewer, { ...license, ...change });
    expect(await resolver.resolve(owner.userId, reference)).toEqual({ availability: 'UNAVAILABLE' });
  });

  it('keeps private drafts unavailable even to their canonical owner', async () => {
    const { library, resolver } = fixture();
    const resource = await library.createDraftResource(owner, { resourceType: 'VOCABULARY', primaryLanguageCode: 'en',
      visibility: 'PRIVATE', details: { term: 'Private', definition: 'Must not leak' } });
    expect(await resolver.resolve(owner.userId, { type: 'LIBRARY_RESOURCE', id: resource.id })).toEqual({ availability: 'UNAVAILABLE' });
  });

  it.each(['PRIVATE', 'HIDDEN', 'DELETED', 'AUTHOR_DISABLED', 'LANGUAGE_DISABLED'] as const)
  ('removes Community cards after current %s revocation, including owner reads', async reason => {
    const { identities, posts, profiles, resolver } = fixture();
    const author = await identities.createUser({ email: randomUUID() + '@phase26.invalid', displayName: 'Synthetic author',
      passwordHash: null, status: 'ACTIVE', emailVerifiedAt: new Date() });
    const post = await posts.createPost({ authorUserId: author.id, targetLanguageCode: 'en', postType: 'DISCUSSION',
      content: 'Current public discussion.', cefrLevel: null, topic: null, visibility: 'PUBLIC', createdAt: new Date() });
    const reference = { type: 'COMMUNITY_POST' as const, id: post.id };
    expect(await resolver.resolve(author.id, reference)).toMatchObject({ availability: 'AVAILABLE', category: 'DISCUSSION' });
    if (reason === 'PRIVATE') await posts.updatePost(post.id, { visibility: 'PRIVATE', updatedAt: new Date(), editedAt: new Date() });
    else if (reason === 'HIDDEN' || reason === 'DELETED') await posts.setPostModerationState(post.id, reason, new Date());
    else if (reason === 'AUTHOR_DISABLED') await identities.updateUser(author.id, { status: 'DISABLED' });
    else await profiles.setActive('en', false);
    expect(await resolver.resolve(author.id, reference)).toEqual({ availability: 'UNAVAILABLE' });
    expect(await resolver.resolve(randomUUID(), reference)).toEqual({ availability: 'UNAVAILABLE' });
  });
});
