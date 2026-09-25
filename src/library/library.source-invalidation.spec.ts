import { InMemoryProfileRepository } from '../profile/profile.repository';
import type { Phase06SourceHealth } from '../corrections/corrections.source-health';
import {
  InMemoryLibraryRepository,
  type LibraryRepository,
} from './library.repository';
import { LibraryService } from './library.service';
import type {
  LibraryActor,
  LibrarySearchCursor,
} from './library.types';

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

  it('paginates over the logical invalid-source set across valid resources', async () => {
    const invalidCandidateIds = new Set<string>();
    const { service, repository } = createService((candidateId) => (
      invalidCandidateIds.has(candidateId)
        ? { valid: false, reason: 'RESPONSE_INACTIVE_OR_MISSING' }
        : { valid: true, reason: 'VALID' }
    ));
    const owner = actor('pagination-owner');
    const reviewer = actor('pagination-reviewer', ['MODERATOR']);
    await service.registerLicense(reviewer, license('PAGINATION-SAFE'));
    const resources: Array<{ resourceId: string; candidateId: string }> = [];
    const baseTime = new Date('2026-09-25T00:00:00.000Z');

    for (let index = 1; index <= 5; index += 1) {
      const candidateId = uuid(100 + index);
      const resource = await createPhase06Resource(
        service,
        owner,
        reviewer,
        `pagination source ${index}`,
        'PAGINATION-SAFE',
        candidateId,
      );
      await repository.transitionReview({
        resourceId: resource.id,
        expectedPreviousState: 'DRAFT',
        expectedProvenanceRevision: 1,
        nextState: 'COMMUNITY_REVIEW',
        action: 'SUBMIT',
        actorUserId: owner.userId,
        note: null,
        occurredAt: new Date(baseTime.getTime() + index * 1_000),
      });
      await repository.transitionReview({
        resourceId: resource.id,
        expectedPreviousState: 'COMMUNITY_REVIEW',
        expectedProvenanceRevision: 1,
        nextState: 'VERIFIED',
        action: 'VERIFY',
        actorUserId: reviewer.userId,
        note: null,
        occurredAt: new Date(baseTime.getTime() + index * 1_000),
      });
      resources.push({ resourceId: resource.id, candidateId });
    }
    for (const index of [2, 4, 5]) invalidCandidateIds.add(uuid(100 + index));

    const first = await service.listInvalidSourceQueue(reviewer, { limit: 2 });
    expect(first.items.map((item) => item.resourceId)).toEqual([
      resources[1].resourceId,
      resources[3].resourceId,
    ]);
    expect(first.nextCursor).not.toBeNull();

    await expect(service.reconcileSource(reviewer, resources[3].resourceId))
      .resolves.toMatchObject({ resource: { reviewState: 'COMMUNITY_REVIEW' } });

    const second = await service.listInvalidSourceQueue(reviewer, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((item) => item.resourceId)).toEqual([resources[4].resourceId]);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.resourceId)).size).toBe(3);

    invalidCandidateIds.clear();
    await expect(service.listInvalidSourceQueue(reviewer, { limit: 2 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('retains exact microsecond boundaries across interleaved invalid-source pages', async () => {
    const invalidCandidateIds = new Set<string>();
    const repository = new ExactInvalidSourceRepository();
    const { service } = createService((candidateId) => (
      invalidCandidateIds.has(candidateId)
        ? { valid: false, reason: 'RESPONSE_INACTIVE_OR_MISSING' }
        : { valid: true, reason: 'VALID' }
    ), repository);
    const owner = actor('microsecond-owner');
    const reviewer = actor('microsecond-reviewer', ['MODERATOR']);
    await service.registerLicense(reviewer, license('MICROSECOND-SAFE'));
    const resources: Array<{ resourceId: string; candidateId: string }> = [];

    for (let index = 1; index <= 5; index += 1) {
      const candidateId = uuid(200 + index);
      const resource = await createPhase06Resource(
        service,
        owner,
        reviewer,
        `microsecond source ${index}`,
        'MICROSECOND-SAFE',
        candidateId,
      );
      await repository.transitionReview({
        resourceId: resource.id,
        expectedPreviousState: 'DRAFT',
        expectedProvenanceRevision: 1,
        nextState: 'COMMUNITY_REVIEW',
        action: 'SUBMIT',
        actorUserId: owner.userId,
        note: null,
        occurredAt: new Date(`2026-09-25T00:00:0${index}.000Z`),
      });
      await repository.transitionReview({
        resourceId: resource.id,
        expectedPreviousState: 'COMMUNITY_REVIEW',
        expectedProvenanceRevision: 1,
        nextState: 'VERIFIED',
        action: 'VERIFY',
        actorUserId: reviewer.userId,
        note: null,
        occurredAt: new Date(`2026-09-25T00:00:0${index}.000Z`),
      });
      resources.push({ resourceId: resource.id, candidateId });
    }

    repository.setOrderedRows(resources.map((resource, index) => ({
      resourceId: resource.resourceId,
      updatedAtMicros: [
        '1789948800123123',
        '1789948800234567',
        '1789948800345678',
        '1789948800456789',
        '1789948800789999',
      ][index],
    })));
    for (const index of [1, 3, 4]) invalidCandidateIds.add(resources[index].candidateId);

    const first = await service.listInvalidSourceQueue(reviewer, { limit: 2 });
    expect(first.items.map((item) => item.resourceId)).toEqual([
      resources[1].resourceId,
      resources[3].resourceId,
    ]);
    expect(first.nextCursor).not.toBeNull();

    const second = await service.listInvalidSourceQueue(reviewer, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((item) => item.resourceId)).toEqual([resources[4].resourceId]);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.resourceId)).size).toBe(3);
  });
});

function createService(
  sourceHealthFor: (candidateId: string) => Phase06SourceHealth,
  repository: LibraryRepository = new InMemoryLibraryRepository(),
): { service: LibraryService; repository: LibraryRepository } {
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
  candidateId = uuid(10),
) {
  const resource = await service.createDraftResource(owner, {
    resourceType: 'GRAMMAR_ITEM',
    primaryLanguageCode: 'en',
    visibility: 'PUBLIC',
    details: { title, explanation: 'source health fixture' },
  });
  await service.attachProvenance(reviewer, resource.id, phase06Provenance(candidateId, licenseKey));
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

class ExactInvalidSourceRepository extends InMemoryLibraryRepository {
  private orderedRows: Array<{ resourceId: string; boundary: LibrarySearchCursor }> = [];

  setOrderedRows(rows: Array<{ resourceId: string; updatedAtMicros: string }>): void {
    this.orderedRows = rows.map((row) => ({
      resourceId: row.resourceId,
      boundary: { updatedAtMicros: row.updatedAtMicros, id: row.resourceId },
    }));
  }

  override async listInvalidSourceQueue(
    input: Parameters<LibraryRepository['listInvalidSourceQueue']>[0],
  ) {
    const rows = this.orderedRows.filter(({ boundary }) => {
      if (!input.cursor) return true;
      const timestamp = BigInt(boundary.updatedAtMicros);
      const cursorTimestamp = BigInt(input.cursor.updatedAtMicros);
      return timestamp > cursorTimestamp || (
        timestamp === cursorTimestamp && boundary.id > input.cursor.id
      );
    });
    const selected = rows.slice(0, input.limit + 1);
    const consumed = selected.slice(0, input.limit);
    const items = await Promise.all(
      consumed.map(({ resourceId }) => this.findResourceById(resourceId)),
    );
    const resolvedItems = items.filter((resource): resource is NonNullable<typeof resource> => Boolean(resource));
    const hasMore = selected.length > input.limit;
    return {
      items: resolvedItems,
      hasMore,
      nextBoundary: hasMore && consumed.at(-1) ? consumed.at(-1)!.boundary : null,
      itemBoundaries: consumed.map(({ boundary }) => boundary),
    };
  }
}

function uuid(number: number): string {
  return `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}
