import { CommunityFailure } from '../community/community.errors';
import { Logger } from '@nestjs/common';
import type { CommunityPostResponse } from '../community/community.service';
import type { LibraryPublicResource } from '../library/library.types';
import { MessageContextResolver } from './message-context-resolver';
import type { MessageContextReference } from './message-context';

const id = 'a18fa91a-8230-45b9-9362-073849628322';
const libraryRef: MessageContextReference = { type: 'LIBRARY_RESOURCE', id };
const communityRef: MessageContextReference = { type: 'COMMUNITY_POST', id };

function fixture() {
  // Boundary fakes represent already-authorized canonical domain projections.
  // Domain eligibility itself remains covered by Library/Community regressions.
  let resource: LibraryPublicResource | null = {
    id, resourceType: 'VOCABULARY', primaryLanguageCode: 'vi', secondaryLanguageCode: null,
    cefrLevel: null, topics: [], reviewState: 'VERIFIED', createdAt: new Date(), updatedAt: new Date(),
    details: { resourceType: 'VOCABULARY', term: 'Học 🌏', definition: 'Learn', partOfSpeech: null, exampleSentence: null },
    provenance: [],
  };
  let post = {
    id, visibility: 'PUBLIC', postType: 'QUESTION', content: 'Explain this? '.repeat(30),
    targetLanguage: { code: 'vi' },
  } as CommunityPostResponse;
  const library = { getPublicResource: jest.fn(async () => resource) };
  const community = { getPost: jest.fn(async (_id: string, _actor: string | null = null) => post) };
  return { library, community, resolver: new MessageContextResolver(library, community),
    revokeLibrary: () => { resource = null; }, mutatePost: (values: Partial<CommunityPostResponse>) => { post = { ...post, ...values }; } };
}

describe('Current canonical message-context projection', () => {
  it('uses canonical Library authorization and returns only a small current card', async () => {
    const { resolver, library } = fixture();
    expect(await resolver.resolve('actor-a', libraryRef)).toEqual({ availability: 'AVAILABLE',
      type: 'LIBRARY_RESOURCE', id, category: 'VOCABULARY', languageCode: 'vi',
      previewText: 'Học 🌏', canonicalPath: '/library/' + id });
    expect(library.getPublicResource).toHaveBeenCalledWith(id);
  });

  it('does not cache live Library metadata across requests or retain an unavailable identity', async () => {
    const { resolver, revokeLibrary } = fixture();
    expect((await resolver.resolve('actor-a', libraryRef)).availability).toBe('AVAILABLE');
    revokeLibrary();
    expect(await resolver.resolve('actor-b', libraryRef)).toEqual({ availability: 'UNAVAILABLE' });
  });

  it('uses current actor Community authorization and a bounded plain preview', async () => {
    const { resolver, community } = fixture();
    const card = await resolver.resolve('actor-b', communityRef);
    expect(card).toEqual({ availability: 'AVAILABLE', type: 'COMMUNITY_POST', id,
      category: 'QUESTION', languageCode: 'vi', previewText: expect.any(String), canonicalPath: '/community/posts/' + id });
    if (card.availability === 'AVAILABLE') expect([...card.previewText].length).toBeLessThanOrEqual(120);
    expect(community.getPost).toHaveBeenCalledWith(id, 'actor-b');
    expect(card).not.toHaveProperty('author');expect(card).not.toHaveProperty('content');
  });

  it.each(['PRIVATE', 'CORRECTION_REQUEST', 'RESOURCE', 'LEARNING_JOURNAL'])('rejects public/type widening: %s', async value => {
    const { resolver, mutatePost } = fixture();
    mutatePost(value === 'PRIVATE' ? { visibility: 'PRIVATE' } : { postType: value as CommunityPostResponse['postType'] });
    expect(await resolver.resolve('author-owner', communityRef)).toEqual({ availability: 'UNAVAILABLE' });
  });

  it('maps genuine current Community unavailability but propagates infrastructure failures', async () => {
    const { resolver, community } = fixture();
    community.getPost.mockRejectedValueOnce(new CommunityFailure('COMMUNITY_POST_UNAVAILABLE', 404, 'Unavailable'));
    expect(await resolver.resolve('actor-b', communityRef)).toEqual({ availability: 'UNAVAILABLE' });
    community.getPost.mockRejectedValueOnce(new Error('Database offline'));
    await expect(resolver.resolve('actor-b', communityRef)).rejects.toThrow('Database offline');
  });

  it('fails closed if a domain returns a different target', async () => {
    const { resolver, mutatePost } = fixture();mutatePost({ id: 'another' });
    expect(await resolver.resolve('actor-b', communityRef)).toEqual({ availability: 'UNAVAILABLE' });
  });

  it('rechecks Community availability across reads without stale preview text', async () => {
    const { resolver, mutatePost } = fixture();
    expect((await resolver.resolve('actor-b', communityRef)).availability).toBe('AVAILABLE');
    mutatePost({ visibility: 'PRIVATE', content: 'Private replacement must never leak' });
    expect(await resolver.resolve('actor-b', communityRef)).toEqual({ availability: 'UNAVAILABLE' });
  });

  it('propagates Library infrastructure and unexpected Community errors', async () => {
    const { resolver, library, community } = fixture();
    library.getPublicResource.mockRejectedValueOnce(new Error('Database offline'));
    await expect(resolver.resolve('actor-a', libraryRef)).rejects.toThrow('Database offline');
    community.getPost.mockRejectedValueOnce(new CommunityFailure('OTHER_FAILURE', 404, 'Unexpected'));
    await expect(resolver.resolve('actor-a', communityRef)).rejects.toMatchObject({ code: 'OTHER_FAILURE' });
  });

  it('renders corrupt persisted kinds unavailable with an identity-free diagnostic', async () => {
    const diagnostic = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const { resolver } = fixture();
      expect(await resolver.resolvePage('actor-b', [{ type: 'UNKNOWN', id } as unknown as MessageContextReference]))
        .toEqual([{ availability: 'UNAVAILABLE' }]);
      expect(diagnostic).toHaveBeenCalledWith('MESSAGE_CONTEXT_REFERENCE_INVALID');
    } finally { diagnostic.mockRestore(); }
  });

  it('deduplicates at most50 references only within the current history request', async () => {
    const { resolver, library } = fixture();
    const refs = [libraryRef, null, libraryRef];
    const cards = await resolver.resolvePage('actor-a', refs);
    expect(cards[0]).toEqual(cards[2]);expect(cards[1]).toBeNull();
    expect(library.getPublicResource).toHaveBeenCalledTimes(1);
    await resolver.resolvePage('actor-b', refs);
    expect(library.getPublicResource).toHaveBeenCalledTimes(2);
    await expect(resolver.resolvePage('actor-a', Array(51).fill(libraryRef))).rejects.toThrow();
  });
});
