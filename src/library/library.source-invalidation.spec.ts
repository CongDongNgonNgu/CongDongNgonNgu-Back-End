import { InMemoryProfileRepository } from '../profile/profile.repository';
import type { Phase06SourceHealth } from '../corrections/corrections.source-health';
import {
  InMemoryLibraryRepository,
  type LibraryRepository,
} from './library.repository';
import { LibraryService } from './library.service';
import type { LibraryActor } from './library.types';

describe('LibraryService Phase 06 source health and reconciliation', () => {
  it('fails public detail/search closed and reconciles a verified invalid source', async () => {
    let sourceHealth: Phase06SourceHealth = { valid: true, reason: 'VALID' };
    const { service, repository } = createService(() => sourceHealth);
    const owner = actor('source-owner');
    const reviewer = actor('source-reviewer', ['MODERATOR']);
    await service.registerLicense(reviewer, license('SOURCE-SAFE'));
    const resource = await createPhase06Resource(service, owner, reviewer);

    await service.transitionReview(owner, resource.id, 'COMMUNITY_REVIEW');
    await service.transitionReview(reviewer, resource.id, 'VERIFIED');
    await expect(service.getPublicResource(resource.id)).resolves.toMatchObject({ id: resource.id });

    sourceHealth = { valid: false, reason: 'CANDIDATE_INVALIDATED' };

    await expect(service.getPublicResource(resource.id)).resolves.toBeNull();
    await expect(service.searchPublicResources({ q: 'phase06 source' }))
      .resolves.toMatchObject({ items: [] });

    const detail = await service.getReviewDetail(reviewer, resource.id);
    expect(detail.provenance[0].sourceHealth).toEqual({
      applicable: true,
      valid: false,
      reason: 'CANDIDATE_INVALIDATED',
    });
    expect(detail.verificationEligibility).toMatchObject({
      eligible: false,
      issues: expect.arrayContaining(['SOURCE_INVALID']),
    });

    await expect(service.listInvalidSourceQueue(reviewer, { limit: 10 }))
      .resolves.toMatchObject({
        items: [expect.objectContaining({
          resourceId: resource.id,
          reviewState: 'VERIFIED',
          publicExposure: false,
          sourceHealth: [expect.objectContaining({
            valid: false,
            reason: 'CANDIDATE_INVALIDATED',
          })],
        })],
      });
    await expect(service.listInvalidSourceQueue(actor('member'), {}))
      .rejects.toMatchObject({ code: 'LIBRARY_REVIEW_FORBIDDEN', status: 403 });

    const reconciled = await service.reconcileSource(reviewer, resource.id, 'Source was invalidated');
    expect(reconciled).toMatchObject({
      resource: { reviewState: 'COMMUNITY_REVIEW' },
      audit: {
        action: 'INVALIDATE',
        previousState: 'VERIFIED',
        newState: 'COMMUNITY_REVIEW',
        actorUserId: reviewer.userId,
      },
    });
    await expect(service.getPublicResource(resource.id)).resolves.toBeNull();
    await expect(service.listReviewAudit(reviewer, resource.id)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'INVALIDATE' })]),
    );
    await expect(service.transitionReview(reviewer, resource.id, 'VERIFIED'))
      .rejects.toMatchObject({ code: 'LIBRARY_SOURCE_INVALID', status: 409 });
    await expect(service.reconcileSource(reviewer, resource.id))
      .rejects.toMatchObject({ code: 'LIBRARY_REVIEW_CONFLICT', status: 409 });
    await expect(service.listInvalidSourceQueue(reviewer, {})).resolves.toMatchObject({ items: [] });
    expect(repository).toBeDefined();
  });

  it('denies a stale invalid-source observation when the source is valid again', async () => {
    let sourceHealth: Phase06SourceHealth = { valid: true, reason: 'VALID' };
    const { service } = createService(() => sourceHealth);
    const owner = actor('stale-owner');
    const reviewer = actor('stale-reviewer', ['ADMIN']);
    await service.registerLicense(reviewer, license('STALE-SAFE'));
    const resource = await createPhase06Resource(service, owner, reviewer, 'stale source', 'STALE-SAFE');
    await service.transitionReview(owner, resource.id, 'COMMUNITY_REVIEW');
    await service.transitionReview(reviewer, resource.id, 'VERIFIED');

    sourceHealth = { valid: false, reason: 'PARENT_NOT_PUBLIC' };
    await expect(service.listInvalidSourceQueue(reviewer, {})).resolves.toMatchObject({
      items: [expect.objectContaining({ resourceId: resource.id })],
    });
    sourceHealth = { valid: true, reason: 'VALID' };

    await expect(service.reconcileSource(reviewer, resource.id))
      .rejects.toMatchObject({ code: 'LIBRARY_SOURCE_STILL_VALID', status: 409 });
    await expect(service.getResource(resource.id)).resolves.toMatchObject({ reviewState: 'VERIFIED' });
    await expect(service.listReviewAudit(reviewer, resource.id)).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'INVALIDATE' })]),
    );
  });

  it('blocks verification when one of multiple Phase 06 sources is invalid', async () => {
    const invalidCandidateId = uuid(2);
    let invalidateSecondSource = false;
    const { service } = createService((healthReference) => (
      invalidateSecondSource && healthReference === invalidCandidateId
        ? { valid: false, reason: 'RESPONSE_INACTIVE_OR_MISSING' }
        : { valid: true, reason: 'VALID' }
    ));
    const owner = actor('multi-owner');
    const reviewer = actor('multi-reviewer', ['MODERATOR']);
    await service.registerLicense(reviewer, license('MULTI-SAFE'));
    const resource = await service.createDraftResource(owner, {
      resourceType: 'GRAMMAR_ITEM',
      primaryLanguageCode: 'en',
      visibility: 'PUBLIC',
      details: { title: 'multiple source', explanation: 'multiple source' },
    });
    await service.attachProvenance(reviewer, resource.id, phase06Provenance(uuid(1), 'MULTI-SAFE'));
    await service.attachProvenance(reviewer, resource.id, phase06Provenance(invalidCandidateId, 'MULTI-SAFE'));
    await service.transitionReview(owner, resource.id, 'COMMUNITY_REVIEW');
    invalidateSecondSource = true;

    await expect(service.transitionReview(reviewer, resource.id, 'VERIFIED'))
      .rejects.toMatchObject({ code: 'LIBRARY_SOURCE_INVALID', status: 409 });
    await expect(service.getResource(resource.id)).resolves.toMatchObject({ reviewState: 'COMMUNITY_REVIEW' });
  });
});

function createService(
  sourceHealthFor: (candidateId: string) => Phase06SourceHealth,
): { service: LibraryService; repository: LibraryRepository } {
  const repository = new InMemoryLibraryRepository();
  const corrections = {
    findLibraryCandidateById: async () => null,
    inspectLibraryCandidateSource: async (reference: { sourceCandidateId: string }) => (
      sourceHealthFor(reference.sourceCandidateId)
    ),
  };
  return {
    repository,
    service: new LibraryService(repository, new InMemoryProfileRepository(), corrections),
  };
}

async function createPhase06Resource(
  service: LibraryService,
  owner: LibraryActor,
  reviewer: LibraryActor,
  title = 'phase06 source',
  licenseKey = 'SOURCE-SAFE',
) {
  const resource = await service.createDraftResource(owner, {
    resourceType: 'GRAMMAR_ITEM',
    primaryLanguageCode: 'en',
    visibility: 'PUBLIC',
    details: { title, explanation: 'source health fixture' },
  });
  await service.attachProvenance(reviewer, resource.id, phase06Provenance(uuid(10), licenseKey));
  return resource;
}

function phase06Provenance(candidateId: string, licenseKey: string) {
  return {
    sourceType: 'PHASE06_LIBRARY_CANDIDATE',
    sourceId: candidateId,
    sourcePostId: uuid(20),
    sourceResponseId: uuid(21),
    sourceCandidateId: candidateId,
    sourceAcceptanceId: uuid(22),
    licenseKey,
    attribution: 'Phase 06 contributor',
  };
}

function actor(userId: string, roles: LibraryActor['roles'] = ['MEMBER']): LibraryActor {
  return { userId, roles };
}

function license(licenseKey: string) {
  return {
    licenseKey,
    displayName: licenseKey,
    canonicalUrl: `https://licenses.example.test/${licenseKey.toLowerCase()}`,
    attributionRequired: true,
    redistributionAllowed: true,
    derivativeConstraints: null,
    active: true,
    sourceNote: 'internal test note',
  };
}

function uuid(number: number): string {
  return `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}
