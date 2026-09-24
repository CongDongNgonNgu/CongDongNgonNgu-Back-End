import { InMemoryProfileRepository } from '../profile/profile.repository';
import {
  InMemoryLibraryRepository,
  type LibraryRepository,
} from './library.repository';
import { LibraryService } from './library.service';
import type { LibraryActor, LibraryResourceRecord } from './library.types';

describe('LibraryService community contribution contract', () => {
  it('returns only approved types and active redistribution-safe licenses', async () => {
    const { service } = createService();
    const reviewer = actor('policy-reviewer', ['MODERATOR']);
    await service.registerLicense(reviewer, license('SAFE-V1', true, true, 'safe source note'));
    await service.registerLicense(reviewer, license('DISABLED-V1', false, true, 'disabled source note'));
    await service.registerLicense(reviewer, license('NO-REDISTRIBUTION-V1', true, false, 'private source note'));
    await service.registerLicense(reviewer, license('UNKNOWN-V1', true, null, 'unknown source note'));

    const first = await service.getContributionPolicy();
    const second = await service.getContributionPolicy();

    expect(first).toEqual(second);
    expect(first.termsVersion).toBe('library-contribution-v1');
    expect(first.approvedResourceTypes).toEqual(['VOCABULARY', 'SENTENCE', 'TRANSLATION']);
    expect(first.licenses).toEqual([{
      licenseKey: 'SAFE-V1',
      displayName: 'SAFE-V1 display',
      canonicalUrl: 'https://licenses.example.test/safe-v1',
      attributionRequired: true,
      redistributionAllowed: true,
      derivativeConstraints: 'Attribution required',
    }]);
    expect(JSON.stringify(first)).not.toContain('sourceNote');
  });

  it('returns no contribution licenses when the registry has no eligible license', async () => {
    const { service } = createService();
    const reviewer = actor('policy-reviewer-empty', ['MODERATOR']);
    await service.registerLicense(reviewer, license('DISABLED-V1', false, true));
    await service.registerLicense(reviewer, license('NO-REDISTRIBUTION-V1', true, false));
    await service.registerLicense(reviewer, license('UNKNOWN-V1', true, null));

    await expect(service.getContributionPolicy()).resolves.toMatchObject({
      termsVersion: 'library-contribution-v1',
      approvedResourceTypes: ['VOCABULARY', 'SENTENCE', 'TRANSLATION'],
      licenses: [],
    });
  });

  it('submits an eligible public draft once and records one contribution event', async () => {
    const { service, repository } = createService();
    const reviewer = actor('submission-reviewer', ['MODERATOR']);
    await service.registerLicense(reviewer, license('SAFE-V1', true, true));
    const resource = await createEligibleResource(service, 'PUBLIC');

    await expect(repository.listContributionEvents(resource.id)).resolves.toHaveLength(0);

    const result = await service.submitContribution(actor('owner-1'), resource.id, {
      termsVersion: 'library-contribution-v1',
      rightsConfirmed: true,
      reuseConsent: true,
    });

    expect(result).toMatchObject({
      resource: { id: resource.id, reviewState: 'COMMUNITY_REVIEW' },
      audit: {
        resourceId: resource.id,
        actorUserId: 'owner-1',
        previousState: 'DRAFT',
        newState: 'COMMUNITY_REVIEW',
        action: 'SUBMIT',
      },
      event: {
        eventType: 'LIBRARY_CONTRIBUTION_SUBMITTED',
        eventVersion: 1,
        resourceId: resource.id,
        contributorUserId: 'owner-1',
        resourceType: 'VOCABULARY',
        termsVersion: 'library-contribution-v1',
        rightsConfirmed: true,
        reuseConsent: true,
      },
    });
    expect(result.event.reviewAuditId).toBe(result.audit.id);
    await expect(repository.listContributionEvents(resource.id)).resolves.toHaveLength(1);
  });

  it.each(['VOCABULARY', 'SENTENCE', 'TRANSLATION'] as const)(
    'requires the dedicated contribution flow for generic %s submission',
    async (resourceType) => {
      const { service, repository } = createService();
      const reviewer = actor('submission-reviewer', ['MODERATOR']);
      await service.registerLicense(reviewer, license('SAFE-V1', true, true));
      const resource = await createEligibleResource(service, 'PUBLIC', resourceType);

      await expect(service.transitionReview(actor('owner-1'), resource.id, 'COMMUNITY_REVIEW'))
        .rejects.toMatchObject({
          code: 'LIBRARY_CONTRIBUTION_SUBMIT_REQUIRED',
        });
      await expect(service.getResource(resource.id)).resolves.toMatchObject({ reviewState: 'DRAFT' });
      await expect(service.listReviewAudit(actor('owner-1'), resource.id)).resolves.toHaveLength(0);
      await expect(repository.listContributionEvents(resource.id)).resolves.toHaveLength(0);

      const submitted = await service.submitContribution(actor('owner-1'), resource.id, validSubmission());
      expect(submitted.resource.reviewState).toBe('COMMUNITY_REVIEW');
      await expect(repository.listContributionEvents(resource.id)).resolves.toHaveLength(1);
    },
  );

  it('retains generic review submission for a non-contribution resource type', async () => {
    const { service, repository } = createService();
    const reviewer = actor('submission-reviewer', ['MODERATOR']);
    await service.registerLicense(reviewer, license('SAFE-V1', true, true));
    const resource = await createEligibleResource(service, 'PRIVATE', 'GRAMMAR_ITEM');

    await expect(service.transitionReview(actor('owner-1'), resource.id, 'COMMUNITY_REVIEW'))
      .resolves.toMatchObject({
        resource: { reviewState: 'COMMUNITY_REVIEW' },
        audit: { action: 'SUBMIT' },
      });
    await expect(repository.listContributionEvents(resource.id)).resolves.toHaveLength(0);
  });

  it('fails closed when moderation is not active at contribution submission', async () => {
    const repository = new NonActiveModerationRepository();
    const { service } = createService(repository);
    await service.registerLicense(actor('submission-reviewer', ['MODERATOR']), license('SAFE-V1', true, true));
    const resource = await createEligibleResource(service, 'PUBLIC');
    repository.markHidden(resource.id);

    await expect(service.submitContribution(actor('owner-1'), resource.id, validSubmission()))
      .rejects.toMatchObject({ code: 'LIBRARY_CONTRIBUTION_MODERATION_REQUIRED' });
    await expect(repository.listContributionEvents(resource.id)).resolves.toHaveLength(0);
  });

  it('rolls back the in-memory review state and audit when event insertion fails', async () => {
    const repository = new EventFailureRepository();
    const { service } = createService(repository);
    await service.registerLicense(actor('submission-reviewer', ['MODERATOR']), license('SAFE-V1', true, true));
    const resource = await createEligibleResource(service, 'PUBLIC');

    await expect(service.submitContribution(actor('owner-1'), resource.id, validSubmission()))
      .rejects.toThrow('event insert failed');
    await expect(service.getResource(resource.id)).resolves.toMatchObject({ reviewState: 'DRAFT' });
    await expect(service.listReviewAudit(actor('owner-1'), resource.id)).resolves.toHaveLength(0);
    await expect(repository.listContributionEvents(resource.id)).resolves.toHaveLength(0);
  });

  it.each([
    {
      label: 'unauthenticated',
      actor: actor('', ['MEMBER']),
      prepare: async (_service: LibraryService) => undefined,
      input: validSubmission(),
      code: 'LIBRARY_ACTOR_INVALID',
    },
    {
      label: 'non-owner member',
      actor: actor('different-member'),
      prepare: async (service: LibraryService) => createEligibleResource(service, 'PUBLIC'),
      input: validSubmission(),
      code: 'LIBRARY_SUBMIT_FORBIDDEN',
    },
    {
      label: 'moderator impersonating the owner',
      actor: actor('different-reviewer', ['MODERATOR']),
      prepare: async (service: LibraryService) => createEligibleResource(service, 'PUBLIC'),
      input: validSubmission(),
      code: 'LIBRARY_SUBMIT_FORBIDDEN',
    },
    {
      label: 'private resource',
      actor: actor('owner-1'),
      prepare: async (service: LibraryService) => createEligibleResource(service, 'PRIVATE'),
      input: validSubmission(),
      code: 'LIBRARY_CONTRIBUTION_PUBLIC_REQUIRED',
    },
    {
      label: 'disallowed resource type',
      actor: actor('owner-1'),
      prepare: async (service: LibraryService) => createEligibleResource(service, 'PUBLIC', 'GRAMMAR_ITEM'),
      input: validSubmission(),
      code: 'LIBRARY_CONTRIBUTION_TYPE_FORBIDDEN',
    },
    {
      label: 'zero provenance',
      actor: actor('owner-1'),
      prepare: async (service: LibraryService) => service.createDraftResource(actor('owner-1'), {
        resourceType: 'VOCABULARY',
        primaryLanguageCode: 'en',
        visibility: 'PUBLIC',
        details: { term: 'word', definition: 'meaning' },
      }),
      input: validSubmission(),
      code: 'LIBRARY_PROVENANCE_REQUIRED',
    },
    {
      label: 'non-original-author provenance',
      actor: actor('owner-1'),
      prepare: async (service: LibraryService) => createReviewerProvenanceResource(service),
      input: validSubmission(),
      code: 'LIBRARY_CONTRIBUTION_PROVENANCE_FORBIDDEN',
    },
    {
      label: 'provenance contributor not bound to actor',
      actor: actor('owner-1'),
      prepare: async (service: LibraryService) => createSpoofedProvenanceResource(service),
      input: validSubmission(),
      code: 'LIBRARY_CONTRIBUTION_PROVENANCE_FORBIDDEN',
    },
    {
      label: 'missing license',
      actor: actor('owner-1'),
      prepare: async (service: LibraryService) => createLicenseStateResource(service, 'missing'),
      input: validSubmission(),
      code: 'LIBRARY_LICENSE_UNKNOWN',
    },
    {
      label: 'disabled license',
      actor: actor('owner-1'),
      prepare: async (service: LibraryService) => createLicenseStateResource(service, 'disabled'),
      input: validSubmission(),
      code: 'LIBRARY_LICENSE_DISABLED',
    },
    {
      label: 'redistribution false',
      actor: actor('owner-1'),
      prepare: async (service: LibraryService) => createLicenseStateResource(service, 'false'),
      input: validSubmission(),
      code: 'LIBRARY_LICENSE_REDISTRIBUTION_REQUIRED',
    },
    {
      label: 'redistribution null',
      actor: actor('owner-1'),
      prepare: async (service: LibraryService) => createLicenseStateResource(service, 'null'),
      input: validSubmission(),
      code: 'LIBRARY_LICENSE_REDISTRIBUTION_REQUIRED',
    },
    {
      label: 'missing terms version',
      actor: actor('owner-1'),
      prepare: async (service: LibraryService) => createEligibleResource(service, 'PUBLIC'),
      input: { rightsConfirmed: true, reuseConsent: true },
      code: 'LIBRARY_CONTRIBUTION_TERMS_REQUIRED',
    },
    {
      label: 'stale terms version',
      actor: actor('owner-1'),
      prepare: async (service: LibraryService) => createEligibleResource(service, 'PUBLIC'),
      input: { termsVersion: 'library-contribution-v0', rightsConfirmed: true, reuseConsent: true },
      code: 'LIBRARY_CONTRIBUTION_TERMS_STALE',
    },
    {
      label: 'rights confirmation false',
      actor: actor('owner-1'),
      prepare: async (service: LibraryService) => createEligibleResource(service, 'PUBLIC'),
      input: { ...validSubmission(), rightsConfirmed: false },
      code: 'LIBRARY_CONTRIBUTION_RIGHTS_CONFIRMATION_REQUIRED',
    },
    {
      label: 'rights confirmation string',
      actor: actor('owner-1'),
      prepare: async (service: LibraryService) => createEligibleResource(service, 'PUBLIC'),
      input: { ...validSubmission(), rightsConfirmed: 'true' },
      code: 'LIBRARY_CONTRIBUTION_RIGHTS_CONFIRMATION_REQUIRED',
    },
    {
      label: 'missing rights confirmation',
      actor: actor('owner-1'),
      prepare: async (service: LibraryService) => createEligibleResource(service, 'PUBLIC'),
      input: { termsVersion: 'library-contribution-v1', reuseConsent: true },
      code: 'LIBRARY_CONTRIBUTION_RIGHTS_CONFIRMATION_REQUIRED',
    },
    {
      label: 'reuse consent false',
      actor: actor('owner-1'),
      prepare: async (service: LibraryService) => createEligibleResource(service, 'PUBLIC'),
      input: { ...validSubmission(), reuseConsent: false },
      code: 'LIBRARY_CONTRIBUTION_REUSE_CONSENT_REQUIRED',
    },
    {
      label: 'reuse consent number',
      actor: actor('owner-1'),
      prepare: async (service: LibraryService) => createEligibleResource(service, 'PUBLIC'),
      input: { ...validSubmission(), reuseConsent: 1 },
      code: 'LIBRARY_CONTRIBUTION_REUSE_CONSENT_REQUIRED',
    },
    {
      label: 'missing reuse consent',
      actor: actor('owner-1'),
      prepare: async (service: LibraryService) => createEligibleResource(service, 'PUBLIC'),
      input: { termsVersion: 'library-contribution-v1', rightsConfirmed: true },
      code: 'LIBRARY_CONTRIBUTION_REUSE_CONSENT_REQUIRED',
    },
  ])('rejects $label without a transition or contribution event', async ({ actor: submitter, prepare, input, code }) => {
    const { service, repository } = createService();
    const reviewer = actor('submission-reviewer', ['MODERATOR']);
    await service.registerLicense(reviewer, license('SAFE-V1', true, true));
    const resource = await prepare(service);
    const resourceId = resource?.id ?? '00000000-0000-4000-8000-000000000099';
    const before = await service.getResource(resourceId);

    await expect(service.submitContribution(submitter, resourceId, input)).rejects.toMatchObject({ code });

    if (before) {
      await expect(service.getResource(resourceId)).resolves.toMatchObject({
        reviewState: before.reviewState,
      });
    } else {
      await expect(service.getResource(resourceId)).resolves.toBeNull();
    }
    await expect(repository.listContributionEvents(resourceId)).resolves.toHaveLength(0);
  });

  it.each(['COMMUNITY_REVIEW', 'VERIFIED', 'REJECTED'] as const)(
    'rejects a resource already in %s deterministically without another event',
    async (state) => {
      const { service, repository } = createService();
      const reviewer = actor('submission-reviewer', ['MODERATOR']);
      await service.registerLicense(reviewer, license('SAFE-V1', true, true));
      const resource = await createEligibleResource(service, 'PUBLIC');
      await repository.transitionReview({
        resourceId: resource.id,
        expectedPreviousState: 'DRAFT',
        expectedProvenanceRevision: resource.provenanceRevision,
        nextState: 'COMMUNITY_REVIEW',
        action: 'SUBMIT',
        actorUserId: 'owner-1',
        note: null,
        occurredAt: new Date(),
      });
      if (state === 'VERIFIED') await service.transitionReview(reviewer, resource.id, 'VERIFIED');
      if (state === 'REJECTED') await service.transitionReview(reviewer, resource.id, 'REJECTED', 'Needs correction');

      await expect(service.submitContribution(actor('owner-1'), resource.id, validSubmission()))
        .rejects.toMatchObject({ code: 'LIBRARY_CONTRIBUTION_CONFLICT' });
      await expect(repository.listContributionEvents(resource.id)).resolves.toHaveLength(0);
      await expect(service.getResource(resource.id)).resolves.toMatchObject({ reviewState: state });
    },
  );

  it('makes a successful retry a deterministic conflict and keeps one event', async () => {
    const { service, repository } = createService();
    await service.registerLicense(actor('submission-reviewer', ['MODERATOR']), license('SAFE-V1', true, true));
    const resource = await createEligibleResource(service, 'PUBLIC');
    const first = await service.submitContribution(actor('owner-1'), resource.id, validSubmission());

    await expect(service.submitContribution(actor('owner-1'), resource.id, validSubmission()))
      .rejects.toMatchObject({ code: 'LIBRARY_CONTRIBUTION_CONFLICT' });
    await expect(repository.listContributionEvents(resource.id)).resolves.toEqual([
      expect.objectContaining({ id: first.event.id, reviewAuditId: first.audit.id }),
    ]);
  });
});

function createService(repository: LibraryRepository = new MutableLicenseRepository()) {
  return {
    repository,
    service: new LibraryService(
      repository,
      new InMemoryProfileRepository(),
      { findLibraryCandidateById: async () => null },
    ),
  };
}

async function createEligibleResource(
  service: LibraryService,
  visibility: 'PUBLIC' | 'PRIVATE',
  resourceType = 'VOCABULARY',
): Promise<LibraryResourceRecord> {
  const resource = await service.createDraftResource(actor('owner-1'), {
    resourceType,
    primaryLanguageCode: 'en',
    ...(resourceType === 'TRANSLATION' ? { secondaryLanguageCode: 'vi' } : {}),
    visibility,
    details: resourceType === 'GRAMMAR_ITEM'
      ? { title: 'Grammar', explanation: 'Explanation' }
      : resourceType === 'SENTENCE'
        ? { text: 'A sentence', context: 'Context' }
        : resourceType === 'TRANSLATION'
          ? { sourceText: 'hello', translatedText: 'xin chào' }
          : { term: 'word', definition: 'meaning' },
  });
  await service.attachProvenance(actor('owner-1'), resource.id, {
    sourceType: 'ORIGINAL_AUTHOR',
    sourceId: 'owner-original',
    licenseKey: 'SAFE-V1',
    attribution: 'Owner attribution',
  });
  return (await service.getResource(resource.id))!;
}

async function createReviewerProvenanceResource(service: LibraryService): Promise<LibraryResourceRecord> {
  const resource = await service.createDraftResource(actor('owner-1'), {
    resourceType: 'VOCABULARY',
    primaryLanguageCode: 'en',
    visibility: 'PUBLIC',
    details: { term: 'word', definition: 'meaning' },
  });
  await service.attachProvenance(actor('submission-reviewer', ['MODERATOR']), resource.id, {
    sourceType: 'COMMUNITY_POST',
    sourceId: 'reviewer-source',
    licenseKey: 'SAFE-V1',
    attribution: 'Reviewer source',
  });
  return (await service.getResource(resource.id))!;
}

async function createSpoofedProvenanceResource(service: LibraryService): Promise<LibraryResourceRecord> {
  const reviewerId = '00000000-0000-4000-8000-000000000010';
  const resource = await service.createDraftResource(actor('owner-1'), {
    resourceType: 'VOCABULARY',
    primaryLanguageCode: 'en',
    visibility: 'PUBLIC',
    details: { term: 'word', definition: 'meaning' },
  });
  await service.attachProvenance(actor(reviewerId, ['MODERATOR']), resource.id, {
    sourceType: 'ORIGINAL_AUTHOR',
    sourceId: 'reviewer-bound-source',
    licenseKey: 'SAFE-V1',
    attribution: 'Wrong contributor',
    originalContributorUserId: reviewerId,
  });
  return (await service.getResource(resource.id))!;
}

async function createLicenseStateResource(
  service: LibraryService,
  state: 'missing' | 'disabled' | 'false' | 'null',
): Promise<LibraryResourceRecord> {
  await service.registerLicense(
    actor('submission-reviewer', ['MODERATOR']),
    license('LICENSE-V1', true, true),
  );
  const resource = await service.createDraftResource(actor('owner-1'), {
    resourceType: 'VOCABULARY',
    primaryLanguageCode: 'en',
    visibility: 'PUBLIC',
    details: { term: 'word', definition: 'meaning' },
  });
  await service.attachProvenance(actor('owner-1'), resource.id, {
    sourceType: 'ORIGINAL_AUTHOR',
    sourceId: 'license-state-source',
    licenseKey: 'LICENSE-V1',
    attribution: 'License state attribution',
  });
  if (state === 'missing') {
    (service as unknown as { repository: MutableLicenseRepository }).repository.hideLicense('LICENSE-V1');
  } else {
    await service.registerLicense(actor('submission-reviewer', ['MODERATOR']), license(
      'LICENSE-V1',
      state === 'disabled' ? false : true,
      state === 'false' ? false : state === 'null' ? null : true,
    ));
  }
  return (await service.getResource(resource.id))!;
}

class MutableLicenseRepository extends InMemoryLibraryRepository {
  private readonly hidden = new Set<string>();

  hideLicense(licenseKey: string): void {
    this.hidden.add(licenseKey);
  }

  override async findLicense(licenseKey: string) {
    if (this.hidden.has(licenseKey)) return null;
    return super.findLicense(licenseKey);
  }
}

class EventFailureRepository extends InMemoryLibraryRepository {
  protected override insertContributionEvent(): never {
    throw new Error('event insert failed');
  }
}

class NonActiveModerationRepository extends InMemoryLibraryRepository {
  private readonly hiddenResourceIds = new Set<string>();

  markHidden(resourceId: string): void {
    this.hiddenResourceIds.add(resourceId);
  }

  override async findResourceById(id: string) {
    const resource = await super.findResourceById(id);
    if (!resource || !this.hiddenResourceIds.has(id)) return resource;
    return { ...resource, moderationState: 'HIDDEN' as const };
  }
}

function validSubmission() {
  return {
    termsVersion: 'library-contribution-v1',
    rightsConfirmed: true,
    reuseConsent: true,
  };
}

function license(
  licenseKey: string,
  active = true,
  redistributionAllowed: boolean | null = true,
  sourceNote = 'internal registry note',
) {
  return {
    licenseKey,
    displayName: licenseKey + ' display',
    canonicalUrl: `https://licenses.example.test/${licenseKey.toLowerCase()}`,
    attributionRequired: true,
    redistributionAllowed,
    derivativeConstraints: 'Attribution required',
    active,
    sourceNote,
  };
}

function actor(userId: string, roles: LibraryActor['roles'] = ['MEMBER']): LibraryActor {
  return { userId, roles };
}
