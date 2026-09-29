import { InMemoryProfileRepository } from '../profile/profile.repository';
import type { LibraryCandidateRecord } from '../corrections/corrections.types';
import {
  InMemoryLibraryRepository,
  type LibraryRepository,
} from './library.repository';
import { LibraryService } from './library.service';
import type {
  IntegrateLibraryCandidateInput,
  LibraryActor,
  LibraryLicenseInput,
} from './library.types';

describe('LibraryService candidate integration', () => {
  it.each([
    ['CORRECTION_PROPOSAL', 'SENTENCE', { text: 'Corrected sentence', context: 'Reviewer context' }],
    ['QA_ANSWER', 'GRAMMAR_ITEM', { title: 'How do I use this?', explanation: 'Use this form.' }],
  ] as const)('binds a valid %s candidate to review without auto-approval', async (kind, resourceType, details) => {
    const candidate = phase06Candidate(kind);
    const { service, repository } = createCandidateService(candidate);
    await registerCommunityLicense(service);

    const result = await service.integrateLibraryCandidate(
      reviewer(),
      candidate.id,
      integrationInput(resourceType, details),
    );

    expect(result).toMatchObject({
      outcome: 'CREATED',
      resource: {
        resourceType,
        primaryLanguageCode: 'en',
        visibility: 'PUBLIC',
        reviewState: 'COMMUNITY_REVIEW',
        createdByUserId: candidate.contributorUserId,
      },
      provenance: {
        sourceType: 'PHASE06_LIBRARY_CANDIDATE',
        sourceId: candidate.id,
        sourcePostId: candidate.sourcePostId,
        sourceResponseId: candidate.sourceResponseId,
        sourceCandidateId: candidate.id,
        sourceAcceptanceId: candidate.acceptanceId,
        originalContributorUserId: candidate.contributorUserId,
      },
      audit: {
        action: 'SUBMIT',
        previousState: 'DRAFT',
        newState: 'COMMUNITY_REVIEW',
        actorUserId: reviewer().userId,
      },
    });
    expect((await repository.listReviewAudit(result.resource.id))).toHaveLength(1);
    expect((await repository.listContributionEvents(result.resource.id))).toHaveLength(0);
    await expect(service.getPublicResource(result.resource.id)).resolves.toBeNull();
  });

  it('reconciles exact retries with one resource, provenance row, and audit', async () => {
    const candidate = phase06Candidate('CORRECTION_PROPOSAL');
    const { service, repository } = createCandidateService(candidate);
    await registerCommunityLicense(service);
    const input = integrationInput('SENTENCE', { text: 'Corrected sentence' });

    const first = await service.integrateLibraryCandidate(reviewer(), candidate.id, input);
    const retry = await service.integrateLibraryCandidate(reviewer(), candidate.id, input);

    expect(retry.outcome).toBe('RECONCILED');
    expect(retry.resource.id).toBe(first.resource.id);
    expect(retry.audit.id).toBe(first.audit.id);
    expect((await service.getResource(first.resource.id))?.provenance).toHaveLength(1);
    expect(await repository.listReviewAudit(first.resource.id)).toHaveLength(1);
  });

  it('fails closed for a conflicting payload and preserves the accepted integration', async () => {
    const candidate = phase06Candidate('QA_ANSWER');
    const { service, repository } = createCandidateService(candidate);
    await registerCommunityLicense(service);
    const first = await service.integrateLibraryCandidate(
      reviewer(),
      candidate.id,
      integrationInput('GRAMMAR_ITEM', { title: 'Question', explanation: 'Answer' }),
    );

    await expect(service.integrateLibraryCandidate(
      reviewer(),
      candidate.id,
      integrationInput('GRAMMAR_ITEM', { title: 'Question', explanation: 'Different answer' }),
    )).rejects.toMatchObject({ code: 'LIBRARY_CANDIDATE_CONFLICT' });
    expect((await service.getResource(first.resource.id))?.reviewState).toBe('COMMUNITY_REVIEW');
    expect(await repository.listReviewAudit(first.resource.id)).toHaveLength(1);
  });

  it('recovers a pre-existing draft with matching candidate provenance without duplicating audit', async () => {
    const candidate = phase06Candidate('CORRECTION_PROPOSAL');
    const { service, repository } = createCandidateService(candidate);
    await registerCommunityLicense(service);
    const input = integrationInput('SENTENCE', { text: 'Corrected sentence' });
    const draft = await service.createDraftResource(
      { userId: candidate.contributorUserId, roles: ['MEMBER'] },
      input,
    );
    await service.attachProvenance(reviewer(), draft.id, {
      sourceType: 'PHASE06_LIBRARY_CANDIDATE',
      sourceId: candidate.id,
      licenseKey: 'COMMUNITY-V1',
      attribution: 'Phase 06 community candidate',
      originalContributorUserId: candidate.contributorUserId,
      sourcePostId: candidate.sourcePostId,
      sourceResponseId: candidate.sourceResponseId,
      sourceCandidateId: candidate.id,
      sourceAcceptanceId: candidate.acceptanceId,
    });

    const result = await service.integrateLibraryCandidate(reviewer(), candidate.id, input);

    expect(result.outcome).toBe('RECONCILED');
    expect(result.resource.id).toBe(draft.id);
    expect(result.resource.reviewState).toBe('COMMUNITY_REVIEW');
    expect(await repository.listReviewAudit(draft.id)).toHaveLength(1);
  });

  it('does not downgrade an already reviewed candidate resource', async () => {
    const candidate = phase06Candidate('CORRECTION_PROPOSAL');
    const { service, repository } = createCandidateService(candidate);
    await registerCommunityLicense(service);
    const input = integrationInput('GRAMMAR_ITEM', { title: 'Correction', explanation: 'Corrected sentence' });
    const draft = await service.createDraftResource(
      { userId: candidate.contributorUserId, roles: ['MEMBER'] },
      input,
    );
    await service.attachProvenance(reviewer(), draft.id, {
      sourceType: 'PHASE06_LIBRARY_CANDIDATE',
      sourceId: candidate.id,
      licenseKey: 'COMMUNITY-V1',
      attribution: 'Phase 06 community candidate',
      originalContributorUserId: candidate.contributorUserId,
      sourcePostId: candidate.sourcePostId,
      sourceResponseId: candidate.sourceResponseId,
      sourceCandidateId: candidate.id,
      sourceAcceptanceId: candidate.acceptanceId,
    });
    await service.transitionReview(
      { userId: candidate.contributorUserId, roles: ['MEMBER'] },
      draft.id,
      'COMMUNITY_REVIEW',
    );
    await service.transitionReview(reviewer(), draft.id, 'VERIFIED', 'Reviewed candidate');

    const result = await service.integrateLibraryCandidate(reviewer(), candidate.id, input);

    expect(result.outcome).toBe('RECONCILED');
    expect(result.resource.reviewState).toBe('VERIFIED');
    expect(await repository.listReviewAudit(draft.id)).toHaveLength(2);
  });

  it('serializes concurrent retries to one logical candidate integration', async () => {
    const candidate = phase06Candidate('QA_ANSWER');
    const { service, repository } = createCandidateService(candidate);
    await registerCommunityLicense(service);
    const input = integrationInput('GRAMMAR_ITEM', { title: 'Question', explanation: 'Answer' });

    const results = await Promise.all(Array.from({ length: 8 }, () => (
      service.integrateLibraryCandidate(reviewer(), candidate.id, input)
    )));

    expect(new Set(results.map((result) => result.resource.id)).size).toBe(1);
    expect(results.filter((result) => result.outcome === 'CREATED')).toHaveLength(1);
    expect(await repository.listReviewAudit(results[0].resource.id)).toHaveLength(1);
  });

  it('requires an explicit reviewer, coherent source, matching language, and pre-existing safe license', async () => {
    const candidate = phase06Candidate('CORRECTION_PROPOSAL');
    const { service } = createCandidateService(candidate, undefined, false);

    await expect(service.integrateLibraryCandidate(
      { userId: candidate.candidateCreatedByUserId, roles: ['MEMBER'] },
      candidate.id,
      integrationInput('SENTENCE', { text: 'Corrected sentence' }),
    )).rejects.toMatchObject({ code: 'LIBRARY_REVIEW_FORBIDDEN' });

    await expect(service.integrateLibraryCandidate(
      reviewer(),
      candidate.id,
      integrationInput('SENTENCE', { text: 'Corrected sentence' }),
    )).rejects.toMatchObject({ code: 'LIBRARY_PHASE06_SOURCE_INVALID' });

    const healthy = createCandidateService(candidate);
    await expect(healthy.service.integrateLibraryCandidate(
      reviewer(),
      candidate.id,
      { ...integrationInput('SENTENCE', { text: 'Corrected sentence' }), licenseKey: 'UNKNOWN-V1' },
    )).rejects.toMatchObject({ code: 'LIBRARY_LICENSE_UNKNOWN' });

    await registerCommunityLicense(healthy.service, false);
    await expect(healthy.service.integrateLibraryCandidate(
      reviewer(),
      candidate.id,
      integrationInput('SENTENCE', { text: 'Corrected sentence' }),
    )).rejects.toMatchObject({ code: 'LIBRARY_LICENSE_REDISTRIBUTION_REQUIRED' });
  });
});

function createCandidateService(
  candidate: LibraryCandidateRecord,
  repository: LibraryRepository = new InMemoryLibraryRepository(),
  sourceHealthy = true,
): { service: LibraryService; repository: LibraryRepository } {
  const profiles = new InMemoryProfileRepository();
  const service = new LibraryService(repository, profiles, {
    findLibraryCandidateById: async (id) => id === candidate.id ? cloneCandidate(candidate) : null,
    inspectLibraryCandidateSource: async () => ({
      valid: sourceHealthy,
      reason: sourceHealthy ? 'VALID' : 'CANDIDATE_INVALIDATED',
    }),
  });
  return { service, repository };
}

async function registerCommunityLicense(service: LibraryService, redistributionAllowed: boolean | null = true): Promise<void> {
  await service.registerLicense(reviewer(), license('COMMUNITY-V1', true, redistributionAllowed));
}

function integrationInput(
  resourceType: 'SENTENCE' | 'GRAMMAR_ITEM',
  details: Record<string, unknown>,
): IntegrateLibraryCandidateInput {
  return {
    resourceType,
    primaryLanguageCode: 'en',
    visibility: 'PUBLIC',
    details,
    licenseKey: 'COMMUNITY-V1',
    attribution: 'Phase 06 community candidate',
  };
}

function reviewer(): LibraryActor {
  return { userId: uuid(90), roles: ['MODERATOR'] };
}

function license(
  licenseKey: string,
  active = true,
  redistributionAllowed: boolean | null = true,
): LibraryLicenseInput {
  return {
    licenseKey,
    displayName: licenseKey,
    canonicalUrl: 'https://licenses.example.test/' + licenseKey.toLowerCase(),
    attributionRequired: true,
    redistributionAllowed,
    active,
  };
}

function phase06Candidate(kind: 'CORRECTION_PROPOSAL' | 'QA_ANSWER'): LibraryCandidateRecord {
  const correction = kind === 'CORRECTION_PROPOSAL';
  return {
    id: uuid(4),
    sourcePostId: uuid(2),
    sourceResponseId: uuid(3),
    contributorUserId: uuid(6),
    targetLanguageCode: 'en',
    responseKind: kind,
    sourceText: correction ? 'Original sentence' : 'How do I use this?',
    correctedText: correction ? 'Corrected sentence' : null,
    answerText: correction ? null : 'Use this form.',
    explanation: correction ? 'Reviewer explanation' : 'Answer explanation',
    acceptanceId: uuid(5),
    acceptedByUserId: uuid(7),
    acceptedAt: new Date('2026-09-21T00:00:00.000Z'),
    candidateCreatedByUserId: uuid(8),
    state: 'PENDING_REVIEW',
    createdAt: new Date('2026-09-21T00:00:00.000Z'),
    updatedAt: new Date('2026-09-21T00:00:00.000Z'),
    invalidatedAt: null,
    invalidationReason: null,
  };
}

function cloneCandidate(candidate: LibraryCandidateRecord): LibraryCandidateRecord {
  return {
    ...candidate,
    acceptedAt: new Date(candidate.acceptedAt),
    createdAt: new Date(candidate.createdAt),
    updatedAt: new Date(candidate.updatedAt),
    invalidatedAt: candidate.invalidatedAt ? new Date(candidate.invalidatedAt) : null,
  };
}

function uuid(value: number): string {
  return '00000000-0000-4000-8000-' + value.toString().padStart(12, '0');
}
