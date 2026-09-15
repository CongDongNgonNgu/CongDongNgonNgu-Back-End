import { InMemoryIdentityRepository } from '../identity/identity.repository';
import { InMemoryProfileRepository } from '../profile/profile.repository';
import { CommunityRateLimiter } from '../community/community.rate-limiter';
import { InMemoryCommunityRepository } from '../community/community.repository';
import { CommunityService } from '../community/community.service';
import { InMemoryCorrectionsRepository } from './corrections.repository';
import { CorrectionsService } from './corrections.service';

describe('CorrectionsService', () => {
  it('preserves the canonical source and context while creating a Community correction parent', async () => {
    const { service, identities } = createService();
    const author = await createUser(identities, 'phase06-author@example.com', 'Phase 06 Author');

    const result = await service.createCorrectionRequest(author.id, {
      languageCode: 'en',
      originalText: '  e\u0301  \r\n下一行  ',
      correctionIntent: 'grammar',
      context: ' \tContext  \r\n next ',
      cefrLevel: 'B1',
      topic: 'Writing Practice',
      visibility: 'PUBLIC',
    });

    expect(result.post.postType).toBe('CORRECTION_REQUEST');
    expect(result.post.content).toBe(' \tContext  \n next ');
    expect(result.correction).toMatchObject({
      postId: result.post.id,
      originalText: '  e\u0301  \n下一行  ',
      correctionIntent: 'GRAMMAR',
      context: ' \tContext  \n next ',
    });
    expect(result.post.topic).toBe('writing-practice');
  });

  it('creates questions and only accepts the matching structured response kind', async () => {
    const { service, identities } = createService();
    const asker = await createUser(identities, 'phase06-asker@example.com', 'Asker');
    const contributor = await createUser(identities, 'phase06-contributor@example.com', 'Contributor');

    const question = await service.createQuestion(asker.id, {
      languageCode: 'en',
      content: '  Why is this phrase natural?\r\n答  ',
      visibility: 'PUBLIC',
    });
    const answer = await service.createStructuredResponse(question.id, contributor.id, {
      responseKind: 'QA_ANSWER',
      answerText: 'Because the context makes the implied subject clear.',
      explanation: 'A concise explanation.',
    });

    expect(question.postType).toBe('QUESTION');
    expect(question.content).toBe('  Why is this phrase natural?\n答  ');
    expect(answer).toMatchObject({
      parentPostId: question.id,
      responseKind: 'QA_ANSWER',
      answerText: 'Because the context makes the implied subject clear.',
      correctedText: null,
    });

    await expect(
      service.createStructuredResponse(question.id, contributor.id, {
        responseKind: 'CORRECTION_PROPOSAL',
        correctedText: 'That is not a question correction.',
      }),
    ).rejects.toMatchObject({ code: 'CORRECTIONS_RESPONSE_KIND_INVALID' });
  });

  it('rejects self responses and unchanged correction proposals', async () => {
    const { service, identities } = createService();
    const author = await createUser(identities, 'phase06-owner@example.com', 'Owner');
    const contributor = await createUser(identities, 'phase06-reviewer@example.com', 'Reviewer');
    const correction = await service.createCorrectionRequest(author.id, {
      languageCode: 'en',
      originalText: 'I has a book.',
      correctionIntent: 'grammar',
    });

    await expect(
      service.createStructuredResponse(correction.post.id, author.id, {
        responseKind: 'CORRECTION_PROPOSAL',
        correctedText: 'I have a book.',
      }),
    ).rejects.toMatchObject({ code: 'CORRECTIONS_SELF_RESPONSE' });

    await expect(
      service.createStructuredResponse(correction.post.id, contributor.id, {
        responseKind: 'CORRECTION_PROPOSAL',
        correctedText: correction.correction.originalText,
      }),
    ).rejects.toMatchObject({ code: 'CORRECTIONS_UNCHANGED_CORRECTION' });
  });

  it('enforces private parent visibility and returns deleted responses as placeholders', async () => {
    const {
      service,
      identities,
      communityRepository,
      correctionsRepository,
    } = createService();
    const owner = await createUser(identities, 'phase06-private-owner@example.com', 'Private Owner');
    const contributor = await createUser(identities, 'phase06-private-contributor@example.com', 'Private Contributor');
    const correction = await service.createCorrectionRequest(owner.id, {
      languageCode: 'en',
      originalText: 'Private source',
      correctionIntent: 'style',
    });

    const response = await service.createStructuredResponse(correction.post.id, contributor.id, {
      responseKind: 'CORRECTION_PROPOSAL',
      correctedText: 'Private corrected source',
    });
    await communityRepository.updatePost(correction.post.id, {
      visibility: 'PRIVATE',
      updatedAt: new Date(),
      editedAt: new Date(),
    });
    await expect(service.getCorrectionRequest(correction.post.id)).rejects.toMatchObject({
      code: 'CORRECTIONS_PARENT_UNAVAILABLE',
    });
    await expect(service.getCorrectionRequest(correction.post.id, owner.id)).resolves.toMatchObject({
      post: { id: correction.post.id, visibility: 'PRIVATE' },
    });

    await correctionsRepository.setStructuredResponseModerationState(
      response.id,
      'DELETED',
      new Date(),
    );

    await expect(
      service.listStructuredResponses(correction.post.id, {}, owner.id),
    ).resolves.toMatchObject({
      items: [{
        id: response.id,
        author: null,
        correctedText: null,
        isDeleted: true,
      }],
    });
  });

  it('paginates structured responses with the Community cursor contract', async () => {
    const { service, identities } = createService();
    const owner = await createUser(identities, 'phase06-page-owner@example.com', 'Page Owner');
    const contributor = await createUser(identities, 'phase06-page-contributor@example.com', 'Page Contributor');
    const question = await service.createQuestion(owner.id, {
      languageCode: 'en',
      content: 'Which answer is clearer?',
    });

    await service.createStructuredResponse(question.id, contributor.id, {
      responseKind: 'QA_ANSWER',
      answerText: 'The first answer.',
    });
    await service.createStructuredResponse(question.id, contributor.id, {
      responseKind: 'QA_ANSWER',
      answerText: 'The second answer.',
    });

    const first = await service.listStructuredResponses(question.id, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await service.listStructuredResponses(question.id, {
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0].id).not.toBe(first.items[0].id);
    expect(second.nextCursor).toBeNull();
  });
});

function createService() {
  const communityRepository = new InMemoryCommunityRepository();
  const identities = new InMemoryIdentityRepository();
  const profiles = new InMemoryProfileRepository();
  const rateLimiter = new CommunityRateLimiter();
  const community = new CommunityService(
    communityRepository,
    profiles,
    identities,
    rateLimiter,
  );
  const correctionsRepository = new InMemoryCorrectionsRepository(communityRepository);
  return {
    identities,
    communityRepository,
    correctionsRepository,
    service: new CorrectionsService(
      correctionsRepository,
      community,
      profiles,
      identities,
      rateLimiter,
    ),
  };
}

async function createUser(
  identities: InMemoryIdentityRepository,
  email: string,
  displayName: string,
) {
  return identities.createUser({
    email,
    displayName,
    passwordHash: null,
    status: 'ACTIVE',
    emailVerifiedAt: new Date(),
  });
}
