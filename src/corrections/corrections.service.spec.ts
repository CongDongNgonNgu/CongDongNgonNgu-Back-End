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

  it('keeps structured Helpful votes idempotent and rejects self-votes', async () => {
    const { service, identities } = createService();
    const owner = await createUser(identities, 'phase06-helpful-owner@example.com', 'Helpful Owner');
    const contributor = await createUser(identities, 'phase06-helpful-contributor@example.com', 'Helpful Contributor');
    const voter = await createUser(identities, 'phase06-helpful-voter@example.com', 'Helpful Voter');
    const question = await service.createQuestion(owner.id, {
      languageCode: 'en',
      content: 'Which explanation is clearer?',
    });
    const response = await service.createStructuredResponse(question.id, contributor.id, {
      responseKind: 'QA_ANSWER',
      answerText: 'The shorter explanation is clearer.',
    });

    const first = await service.addStructuredResponseHelpfulVote(response.id, voter.id);
    const duplicate = await service.addStructuredResponseHelpfulVote(response.id, voter.id);
    expect(first).toMatchObject({ helpfulCount: 1, viewerHelpful: true, canVote: true });
    expect(duplicate).toMatchObject({ helpfulCount: 1, viewerHelpful: true });

    await expect(
      service.addStructuredResponseHelpfulVote(response.id, contributor.id),
    ).rejects.toMatchObject({ code: 'CORRECTIONS_SELF_VOTE' });

    const removed = await service.removeStructuredResponseHelpfulVote(response.id, voter.id);
    const removedAgain = await service.removeStructuredResponseHelpfulVote(response.id, voter.id);
    expect(removed).toMatchObject({ helpfulCount: 0, viewerHelpful: false });
    expect(removedAgain).toMatchObject({ helpfulCount: 0, viewerHelpful: false });
  });

  it('allows only the requester to accept, change, and revoke one response', async () => {
    const { service, identities } = createService();
    const owner = await createUser(identities, 'phase06-accept-owner@example.com', 'Accept Owner');
    const contributorA = await createUser(identities, 'phase06-accept-a@example.com', 'Accept A');
    const contributorB = await createUser(identities, 'phase06-accept-b@example.com', 'Accept B');
    const otherOwner = await createUser(identities, 'phase06-accept-other-owner@example.com', 'Other Owner');
    const correction = await service.createCorrectionRequest(owner.id, {
      languageCode: 'en',
      originalText: 'She go to school.',
      correctionIntent: 'grammar',
    });
    const otherCorrection = await service.createCorrectionRequest(otherOwner.id, {
      languageCode: 'en',
      originalText: 'He walk home.',
      correctionIntent: 'grammar',
    });
    const responseA = await service.createStructuredResponse(correction.post.id, contributorA.id, {
      responseKind: 'CORRECTION_PROPOSAL',
      correctedText: 'She goes to school.',
      explanation: 'Third-person singular takes goes.',
    });
    const responseB = await service.createStructuredResponse(correction.post.id, contributorB.id, {
      responseKind: 'CORRECTION_PROPOSAL',
      correctedText: 'She attends school.',
      explanation: 'A natural alternative.',
    });

    const accepted = await service.acceptStructuredResponse(correction.post.id, responseA.id, owner.id);
    const acceptedAgain = await service.acceptStructuredResponse(correction.post.id, responseA.id, owner.id);
    expect(accepted).toMatchObject({ id: responseA.id, isAccepted: true, canAccept: true });
    expect(acceptedAgain).toMatchObject({ id: responseA.id, isAccepted: true });

    await expect(
      service.acceptStructuredResponse(correction.post.id, responseA.id, contributorA.id),
    ).rejects.toMatchObject({ code: 'CORRECTIONS_ACCEPT_FORBIDDEN' });
    await expect(
      service.acceptStructuredResponse(otherCorrection.post.id, responseA.id, otherOwner.id),
    ).rejects.toMatchObject({ code: 'CORRECTIONS_ACCEPT_INVALID' });

    const changed = await service.acceptStructuredResponse(correction.post.id, responseB.id, owner.id);
    expect(changed).toMatchObject({ id: responseB.id, isAccepted: true });
    await expect(service.getStructuredResponse(responseA.id, owner.id)).resolves.toMatchObject({
      id: responseA.id,
      isAccepted: false,
      acceptedAt: null,
    });

    const revoked = await service.revokeStructuredResponseAcceptance(correction.post.id, owner.id);
    const revokedAgain = await service.revokeStructuredResponseAcceptance(correction.post.id, owner.id);
    expect(revoked).toMatchObject({ parentPostId: correction.post.id, responseId: responseB.id, revoked: true });
    expect(revokedAgain).toMatchObject({ parentPostId: correction.post.id, responseId: null, revoked: false });
    await expect(service.getStructuredResponse(responseB.id, owner.id)).resolves.toMatchObject({
      id: responseB.id,
      isAccepted: false,
      acceptedAt: null,
    });
  });

  it('serializes concurrent in-memory acceptance changes to one active response', async () => {
    const { service, identities } = createService();
    const owner = await createUser(identities, 'phase06-concurrent-owner@example.com', 'Concurrent Owner');
    const contributorA = await createUser(identities, 'phase06-concurrent-a@example.com', 'Concurrent A');
    const contributorB = await createUser(identities, 'phase06-concurrent-b@example.com', 'Concurrent B');
    const question = await service.createQuestion(owner.id, {
      languageCode: 'en',
      content: 'Which answer should be accepted?',
    });
    const responseA = await service.createStructuredResponse(question.id, contributorA.id, {
      responseKind: 'QA_ANSWER',
      answerText: 'Answer A.',
    });
    const responseB = await service.createStructuredResponse(question.id, contributorB.id, {
      responseKind: 'QA_ANSWER',
      answerText: 'Answer B.',
    });

    await Promise.all([
      service.acceptStructuredResponse(question.id, responseA.id, owner.id),
      service.acceptStructuredResponse(question.id, responseB.id, owner.id),
    ]);

    const listed = await service.listStructuredResponses(question.id, {}, owner.id);
    expect(listed.items.filter((item) => item.isAccepted)).toHaveLength(1);
  });

  it('does not allow Helpful actions on hidden, deleted, or private-unreadable responses', async () => {
    const { service, identities, communityRepository, correctionsRepository } = createService();
    const owner = await createUser(identities, 'phase06-interaction-private-owner@example.com', 'Private Interaction Owner');
    const contributor = await createUser(identities, 'phase06-interaction-private-contributor@example.com', 'Private Interaction Contributor');
    const voter = await createUser(identities, 'phase06-interaction-private-voter@example.com', 'Private Interaction Voter');
    const correction = await service.createCorrectionRequest(owner.id, {
      languageCode: 'en',
      originalText: 'Private source.',
      correctionIntent: 'style',
    });
    const response = await service.createStructuredResponse(correction.post.id, contributor.id, {
      responseKind: 'CORRECTION_PROPOSAL',
      correctedText: 'Private source!',
    });

    await communityRepository.updatePost(correction.post.id, {
      visibility: 'PRIVATE',
      updatedAt: new Date(),
      editedAt: new Date(),
    });
    await expect(
      service.addStructuredResponseHelpfulVote(response.id, voter.id),
    ).rejects.toMatchObject({ code: 'CORRECTIONS_PARENT_UNAVAILABLE' });

    await communityRepository.updatePost(correction.post.id, {
      visibility: 'PUBLIC',
      updatedAt: new Date(),
      editedAt: new Date(),
    });
    await correctionsRepository.setStructuredResponseModerationState(response.id, 'HIDDEN', new Date());
    await expect(
      service.addStructuredResponseHelpfulVote(response.id, voter.id),
    ).rejects.toMatchObject({ code: 'CORRECTIONS_RESPONSE_UNAVAILABLE' });

    await correctionsRepository.setStructuredResponseModerationState(response.id, 'DELETED', new Date());
    await expect(
      service.removeStructuredResponseHelpfulVote(response.id, voter.id),
    ).rejects.toMatchObject({ code: 'CORRECTIONS_RESPONSE_UNAVAILABLE' });
  });

  it('records accepted contribution evidence and creates one pending public candidate idempotently', async () => {
    const { service, identities, correctionsRepository } = createService();
    const owner = await createUser(identities, 'phase06-candidate-owner@example.com', 'Candidate Owner');
    const contributor = await createUser(identities, 'phase06-candidate-contributor@example.com', 'Candidate Contributor');
    const other = await createUser(identities, 'phase06-candidate-other@example.com', 'Candidate Other');
    const correction = await service.createCorrectionRequest(owner.id, {
      languageCode: 'en',
      originalText: 'She go home.',
      correctionIntent: 'grammar',
      visibility: 'PUBLIC',
    });
    const response = await service.createStructuredResponse(correction.post.id, contributor.id, {
      responseKind: 'CORRECTION_PROPOSAL',
      correctedText: 'She goes home.',
      explanation: 'Third-person singular uses goes.',
    });

    await expect(
      service.nominateStructuredResponseAsLibraryCandidate(response.id, other.id),
    ).rejects.toMatchObject({ code: 'CORRECTIONS_CANDIDATE_FORBIDDEN' });
    await expect(
      service.nominateStructuredResponseAsLibraryCandidate(response.id, owner.id),
    ).rejects.toMatchObject({ code: 'CORRECTIONS_CANDIDATE_NOT_ACCEPTED' });

    await service.acceptStructuredResponse(correction.post.id, response.id, owner.id);
    const candidate = await service.nominateStructuredResponseAsLibraryCandidate(response.id, owner.id);
    const duplicate = await service.nominateStructuredResponseAsLibraryCandidate(response.id, owner.id);

    expect(candidate).toMatchObject({
      sourcePostId: correction.post.id,
      sourceResponseId: response.id,
      responseKind: 'CORRECTION_PROPOSAL',
      state: 'PENDING_REVIEW',
      submittedForReview: true,
    });
    expect(duplicate.id).toBe(candidate.id);
    await expect(correctionsRepository.listPendingLibraryCandidates()).resolves.toMatchObject([{
      id: candidate.id,
      sourcePostId: correction.post.id,
      sourceResponseId: response.id,
      sourceText: 'She go home.',
      correctedText: 'She goes home.',
      contributorUserId: contributor.id,
      candidateCreatedByUserId: owner.id,
      state: 'PENDING_REVIEW',
    }]);

    const events = await correctionsRepository.listContributionEvents({ responseId: response.id });
    expect(events.map((event) => event.eventType)).toEqual([
      'STRUCTURED_RESPONSE_CREATED',
      'RESPONSE_ACCEPTED',
      'LIBRARY_CANDIDATE_CREATED',
    ]);
  });

  it('fails closed for private sources and preserves reversal evidence after acceptance revoke', async () => {
    const { service, identities, communityRepository, correctionsRepository } = createService();
    const owner = await createUser(identities, 'phase06-candidate-private-owner@example.com', 'Private Candidate Owner');
    const contributor = await createUser(identities, 'phase06-candidate-private-contributor@example.com', 'Private Candidate Contributor');
    const privateCorrection = await service.createCorrectionRequest(owner.id, {
      languageCode: 'en',
      originalText: 'Private source.',
      correctionIntent: 'style',
      visibility: 'PUBLIC',
    });
    const privateResponse = await service.createStructuredResponse(privateCorrection.post.id, contributor.id, {
      responseKind: 'CORRECTION_PROPOSAL',
      correctedText: 'Private source!',
    });
    await communityRepository.updatePost(privateCorrection.post.id, {
      visibility: 'PRIVATE',
      updatedAt: new Date(),
      editedAt: new Date(),
    });
    await service.acceptStructuredResponse(privateCorrection.post.id, privateResponse.id, owner.id);
    await expect(
      service.nominateStructuredResponseAsLibraryCandidate(privateResponse.id, owner.id),
    ).rejects.toMatchObject({ code: 'CORRECTIONS_CANDIDATE_SOURCE_NOT_PUBLIC' });

    const publicCorrection = await service.createCorrectionRequest(owner.id, {
      languageCode: 'en',
      originalText: 'Reversible source.',
      correctionIntent: 'style',
      visibility: 'PUBLIC',
    });
    const publicResponse = await service.createStructuredResponse(publicCorrection.post.id, contributor.id, {
      responseKind: 'CORRECTION_PROPOSAL',
      correctedText: 'Reversible source!',
    });
    await service.acceptStructuredResponse(publicCorrection.post.id, publicResponse.id, owner.id);
    await service.nominateStructuredResponseAsLibraryCandidate(publicResponse.id, owner.id);
    await service.revokeStructuredResponseAcceptance(publicCorrection.post.id, owner.id);

    await expect(correctionsRepository.listPendingLibraryCandidates()).resolves.toHaveLength(0);
    const events = await correctionsRepository.listContributionEvents({ responseId: publicResponse.id });
    expect(events.map((event) => event.eventType)).toEqual([
      'STRUCTURED_RESPONSE_CREATED',
      'RESPONSE_ACCEPTED',
      'LIBRARY_CANDIDATE_CREATED',
      'ACCEPTANCE_REVOKED',
    ]);

    await communityRepository.updatePost(publicCorrection.post.id, {
      visibility: 'PRIVATE',
      updatedAt: new Date(),
      editedAt: new Date(),
    });
    await expect(correctionsRepository.listPendingLibraryCandidates()).resolves.toHaveLength(0);
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
