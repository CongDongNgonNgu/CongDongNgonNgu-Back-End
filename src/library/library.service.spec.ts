import { InMemoryProfileRepository } from '../profile/profile.repository';
import type { LibraryCandidateRecord } from '../corrections/corrections.types';
import {
  InMemoryLibraryRepository,
  type LibraryRepository,
} from './library.repository';
import { decodeLibrarySearchCursor } from './library.pagination';
import { LibraryService } from './library.service';
import type {
  LibraryActor,
  LibraryLicenseInput,
  NormalizedLibraryProvenanceInput,
  LibraryContributionResourceType,
  LibraryResourceType,
} from './library.types';
import { LIBRARY_CONTRIBUTION_RESOURCE_TYPES } from './library.types';

describe('LibraryService', () => {
  it.each(resourceFixtures())('creates a draft for %s without flattening type-specific data', async (resourceType, details) => {
    const { service } = createService();
    const resource = await service.createDraftResource(actor('owner-1'), {
      resourceType,
      primaryLanguageCode: 'en',
      secondaryLanguageCode: resourceType === 'TRANSLATION' ? 'vi' : undefined,
      details,
    });

    expect(resource).toMatchObject({
      resourceType,
      reviewState: 'DRAFT',
      createdByUserId: 'owner-1',
      details: { resourceType },
    });
  });

  it('validates active language catalog entries and resource type allowlists', async () => {
    const { service } = createService();

    await expect(service.createDraftResource(actor('owner-1'), {
      resourceType: 'VOCABULARY',
      primaryLanguageCode: 'xx',
      details: { term: 'word', definition: 'meaning' },
    })).rejects.toMatchObject({ code: 'LIBRARY_LANGUAGE_UNAVAILABLE' });

    await expect(service.createDraftResource(actor('owner-1'), {
      resourceType: 'NOT_A_RESOURCE',
      primaryLanguageCode: 'en',
      details: {},
    })).rejects.toMatchObject({ code: 'LIBRARY_RESOURCE_TYPE_INVALID' });
  });

  it('requires an active normalized license before provenance can be attached', async () => {
    const { service } = createService();
    await service.registerLicense(actor('moderator-1', ['MODERATOR']), license('COMMUNITY-V1'));
    await service.registerLicense(actor('moderator-1', ['MODERATOR']), license('DISABLED-V1', false));
    const resource = await createVocabulary(service);

    await expect(service.attachProvenance(actor('owner-1'), resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'manual-1',
      licenseKey: 'UNKNOWN-V1',
      attribution: 'Unknown source',
    })).rejects.toMatchObject({ code: 'LIBRARY_LICENSE_UNKNOWN' });

    await expect(service.attachProvenance(actor('owner-1'), resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'manual-2',
      licenseKey: 'DISABLED-V1',
      attribution: 'Disabled source',
    })).rejects.toMatchObject({ code: 'LIBRARY_LICENSE_DISABLED' });
  });

  it('preserves multiple provenance sources and does not overwrite duplicate attribution', async () => {
    const { service } = createService();
    await service.registerLicense(actor('moderator-1', ['MODERATOR']), license('COMMUNITY-V1'));
    await service.registerLicense(actor('moderator-1', ['MODERATOR']), license('DATASET-V1'));
    const resource = await createVocabulary(service);

    await service.attachProvenance(actor('owner-1'), resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'author-1',
      licenseKey: 'COMMUNITY-V1',
      attribution: 'Community contributor',
    });
    await service.attachProvenance(actor('owner-1'), resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'dataset-1',
      licenseKey: 'DATASET-V1',
      attribution: 'Dataset attribution',
    });

    await expect(service.attachProvenance(actor('owner-1'), resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'author-1',
      licenseKey: 'COMMUNITY-V1',
      attribution: 'Changed attribution',
    })).rejects.toMatchObject({ code: 'LIBRARY_PROVENANCE_DUPLICATE' });

    const merged = await service.mergeProvenance(actor('owner-1'), resource.id, [{
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'author-1',
      licenseKey: 'COMMUNITY-V1',
      attribution: 'Community contributor',
    }, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'author-2',
      licenseKey: 'COMMUNITY-V1',
      attribution: 'Original author',
    }]);

    expect(merged).toHaveLength(3);
    expect(merged.map((entry) => entry.attribution)).toEqual(expect.arrayContaining([
      'Community contributor',
      'Dataset attribution',
      'Original author',
    ]));
  });

  it('keeps Phase 06 candidate provenance typed and pending until review', async () => {
    const candidate = phase06Candidate();
    const { service } = createService(async (id) => id === candidate.id ? candidate : null);
    await service.registerLicense(actor('moderator-1', ['MODERATOR']), license('COMMUNITY-V1'));
    const resource = await createVocabulary(service);
    const provenance = await service.attachProvenance(actor('moderator-1', ['MODERATOR']), resource.id, {
      sourceType: 'PHASE06_LIBRARY_CANDIDATE',
      sourceId: candidate.id,
      licenseKey: 'COMMUNITY-V1',
      attribution: 'Phase 06 contributor',
      sourcePostId: candidate.sourcePostId,
      sourceResponseId: candidate.sourceResponseId,
      sourceCandidateId: candidate.id,
      sourceAcceptanceId: candidate.acceptanceId,
      originalContributorUserId: uuid(6),
    });

    expect(provenance).toMatchObject({
      sourceType: 'PHASE06_LIBRARY_CANDIDATE',
      sourcePostId: candidate.sourcePostId,
      sourceResponseId: candidate.sourceResponseId,
      sourceCandidateId: candidate.id,
      sourceAcceptanceId: candidate.acceptanceId,
      originalContributorUserId: uuid(6),
    });
    expect((await service.getResource(resource.id))?.reviewState).toBe('DRAFT');
  });

  it.each(['OPEN_DATASET', 'PHASE06_LIBRARY_CANDIDATE', 'COMMUNITY_POST', 'MANUAL_ENTRY'] as const)(
    'denies a normal member from claiming %s provenance', async (sourceType) => {
      const candidate = phase06Candidate();
      const { service } = createService(async (id) => id === candidate.id ? candidate : null);
      await service.registerLicense(actor('moderator-1', ['MODERATOR']), license('COMMUNITY-V1'));
      const resource = await createVocabulary(service);

      await expect(service.attachProvenance(actor('owner-1'), resource.id, {
        sourceType,
        sourceId: sourceType === 'PHASE06_LIBRARY_CANDIDATE' ? candidate.id : 'restricted-source-1',
        licenseKey: 'COMMUNITY-V1',
        attribution: 'Restricted source',
        ...(sourceType === 'PHASE06_LIBRARY_CANDIDATE' ? {
          sourcePostId: candidate.sourcePostId,
          sourceResponseId: candidate.sourceResponseId,
          sourceCandidateId: candidate.id,
          sourceAcceptanceId: candidate.acceptanceId,
        } : {}),
      })).rejects.toMatchObject({ code: 'LIBRARY_PROVENANCE_SOURCE_FORBIDDEN' });
    },
  );

  it('requires all Phase 06 references to match the canonical pending candidate', async () => {
    const candidate = phase06Candidate();
    const { service } = createService(async (id) => id === candidate.id ? candidate : null);
    await service.registerLicense(actor('moderator-1', ['MODERATOR']), license('COMMUNITY-V1'));
    const resource = await createVocabulary(service);

    await expect(service.attachProvenance(actor('moderator-1', ['MODERATOR']), resource.id, {
      sourceType: 'PHASE06_LIBRARY_CANDIDATE',
      sourceId: candidate.id,
      licenseKey: 'COMMUNITY-V1',
      attribution: 'Missing acceptance',
      sourcePostId: candidate.sourcePostId,
      sourceResponseId: candidate.sourceResponseId,
      sourceCandidateId: candidate.id,
    })).rejects.toMatchObject({ code: 'LIBRARY_PHASE06_SOURCE_INVALID' });

    await expect(service.attachProvenance(actor('moderator-1', ['MODERATOR']), resource.id, {
      sourceType: 'PHASE06_LIBRARY_CANDIDATE',
      sourceId: candidate.id,
      licenseKey: 'COMMUNITY-V1',
      attribution: 'Mismatched response',
      sourcePostId: candidate.sourcePostId,
      sourceResponseId: uuid(30),
      sourceCandidateId: candidate.id,
      sourceAcceptanceId: candidate.acceptanceId,
    })).rejects.toMatchObject({ code: 'LIBRARY_PHASE06_SOURCE_INVALID' });

    const invalidated = { ...candidate, state: 'INVALIDATED' as const };
    const invalidatedService = createService(async (id) => id === invalidated.id ? invalidated : null).service;
    await invalidatedService.registerLicense(actor('moderator-1', ['MODERATOR']), license('COMMUNITY-V1'));
    const invalidatedResource = await createVocabulary(invalidatedService);
    await expect(invalidatedService.attachProvenance(actor('moderator-1', ['MODERATOR']), invalidatedResource.id, {
      sourceType: 'PHASE06_LIBRARY_CANDIDATE',
      sourceId: invalidated.id,
      licenseKey: 'COMMUNITY-V1',
      attribution: 'Invalidated candidate',
      sourcePostId: invalidated.sourcePostId,
      sourceResponseId: invalidated.sourceResponseId,
      sourceCandidateId: invalidated.id,
      sourceAcceptanceId: invalidated.acceptanceId,
    })).rejects.toMatchObject({ code: 'LIBRARY_PHASE06_SOURCE_INVALID' });
  });

  it('rejects Phase 06-only references on unrelated provenance types', async () => {
    const { service } = createService();
    await service.registerLicense(actor('moderator-1', ['MODERATOR']), license('COMMUNITY-V1'));
    const resource = await createVocabulary(service);

    await expect(service.attachProvenance(actor('owner-1'), resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'author-1',
      licenseKey: 'COMMUNITY-V1',
      attribution: 'Original author',
      sourcePostId: uuid(2),
    })).rejects.toMatchObject({ code: 'LIBRARY_SOURCE_REFERENCE_INVALID' });
  });

  it('requires owner submission and denies submitter self-verification', async () => {
    const { service } = createService();
    await service.registerLicense(actor('moderator-1', ['MODERATOR']), license('COMMUNITY-V1'));
    const resource = await createVocabulary(service, 'PUBLIC');
    await service.attachProvenance(actor('owner-1'), resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'manual-1',
      licenseKey: 'COMMUNITY-V1',
      attribution: 'Owner attribution',
    });

    await expect(service.getPublicResource(resource.id)).resolves.toBeNull();
    await expect(service.transitionReview(actor('other-1'), resource.id, 'COMMUNITY_REVIEW'))
      .rejects.toMatchObject({ code: 'LIBRARY_SUBMIT_FORBIDDEN' });
    await expect(service.transitionReview(actor('owner-1'), resource.id, 'COMMUNITY_REVIEW'))
      .rejects.toMatchObject({ code: 'LIBRARY_CONTRIBUTION_SUBMIT_REQUIRED' });
    await expect(submitCommunityContribution(service, resource.id))
      .resolves.toMatchObject({ resource: { reviewState: 'COMMUNITY_REVIEW' }, audit: { action: 'SUBMIT' } });
    await expect(service.transitionReview(actor('owner-1', ['MODERATOR']), resource.id, 'VERIFIED'))
      .rejects.toMatchObject({ code: 'LIBRARY_SELF_VERIFICATION_DENIED' });
  });

  it('allows a moderator to verify, reject, and invalidate with an auditable transition', async () => {
    const { service } = createService();
    await service.registerLicense(actor('admin-1', ['ADMIN']), license('COMMUNITY-V1'));
    const resource = await createVocabulary(service, 'PUBLIC');
    await service.attachProvenance(actor('owner-1'), resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'manual-1',
      licenseKey: 'COMMUNITY-V1',
      attribution: 'Owner attribution',
    });
    await submitCommunityContribution(service, resource.id);

    const verified = await service.transitionReview(
      actor('moderator-1', ['MODERATOR']),
      resource.id,
      'VERIFIED',
      'Checked source and language content',
    );
    expect(verified).toMatchObject({
      resource: { reviewState: 'VERIFIED' },
      audit: { action: 'VERIFY', note: 'Checked source and language content' },
    });

    const publicResource = await service.getPublicResource(resource.id);
    expect(publicResource).toMatchObject({
      id: resource.id,
      reviewState: 'VERIFIED',
      provenance: [{ attribution: 'Owner attribution' }],
    });
    expect(publicResource).not.toHaveProperty('reviewNotes');
    expect(publicResource?.provenance[0]).not.toHaveProperty('originalContributorUserId');

    const invalidated = await service.transitionReview(
      actor('moderator-1', ['MODERATOR']),
      resource.id,
      'REJECTED',
      'Source was later invalidated',
    );
    expect(invalidated).toMatchObject({
      resource: { reviewState: 'REJECTED' },
      audit: { action: 'INVALIDATE', note: 'Source was later invalidated' },
    });
    await expect(service.getPublicResource(resource.id)).resolves.toBeNull();
  });

  it('rejects reviewed content with an internal note and never projects it publicly', async () => {
    const { service } = createService();
    await service.registerLicense(actor('moderator-1', ['MODERATOR']), license('COMMUNITY-V1'));
    const resource = await createVocabulary(service, 'PUBLIC');
    await service.attachProvenance(actor('owner-1'), resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'manual-1',
      licenseKey: 'COMMUNITY-V1',
      attribution: 'Owner attribution',
    });
    await submitCommunityContribution(service, resource.id);
    await expect(service.transitionReview(
      actor('moderator-1', ['MODERATOR']),
      resource.id,
      'REJECTED',
      'Internal reviewer note',
    )).resolves.toMatchObject({ audit: { action: 'REJECT', note: 'Internal reviewer note' } });

    await expect(service.getPublicResource(resource.id)).resolves.toBeNull();
    await expect(service.listReviewAudit(actor('moderator-1', ['MODERATOR']), resource.id))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ note: 'Internal reviewer note' }),
      ]));
  });

  it.each([
    { label: 'false', redistributionAllowed: false as const },
    { label: 'unknown', redistributionAllowed: null },
  ])('fails closed for a public license whose redistribution permission is $label', async ({ redistributionAllowed }) => {
    const { service } = createService();
    await service.registerLicense(actor('moderator-1', ['MODERATOR']), license('UNSAFE-V1', true, true));
    const resource = await createVocabulary(service, 'PUBLIC');
    await service.attachProvenance(actor('owner-1'), resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'author-unsafe',
      licenseKey: 'UNSAFE-V1',
      attribution: 'Original author',
    });
    await submitCommunityContribution(service, resource.id);
    await service.registerLicense(
      actor('moderator-1', ['MODERATOR']),
      license('UNSAFE-V1', true, redistributionAllowed),
    );

    await expect(service.transitionReview(
      actor('moderator-1', ['MODERATOR']),
      resource.id,
      'VERIFIED',
    )).rejects.toMatchObject({ code: 'LIBRARY_LICENSE_REDISTRIBUTION_REQUIRED' });
    await expect(service.getPublicResource(resource.id)).resolves.toBeNull();
  });

  it('requires explicit redistribution permission before verifying a public resource', async () => {
    const { service } = createService();
    await service.registerLicense(actor('moderator-1', ['MODERATOR']), license('SAFE-V1', true, true));
    const resource = await createVocabulary(service, 'PUBLIC');
    await service.attachProvenance(actor('owner-1'), resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'author-safe',
      licenseKey: 'SAFE-V1',
      attribution: 'Original author',
    });
    await submitCommunityContribution(service, resource.id);
    await expect(service.transitionReview(
      actor('moderator-1', ['MODERATOR']),
      resource.id,
      'VERIFIED',
    )).resolves.toMatchObject({ resource: { reviewState: 'VERIFIED' } });
    await expect(service.getPublicResource(resource.id)).resolves.toMatchObject({
      id: resource.id,
      provenance: [{ license: { redistributionAllowed: true } }],
    });
  });

  it.each([
    { label: 'inactive', active: false, redistributionAllowed: true as const },
    { label: 'false', active: true, redistributionAllowed: false as const },
    { label: 'unknown', active: true, redistributionAllowed: null },
  ])('removes a public resource when its registry license later becomes $label', async ({ active, redistributionAllowed }) => {
    const { service } = createService();
    const reviewer = actor('moderator-1', ['MODERATOR']);
    await service.registerLicense(reviewer, license('LATER-V1', true, true));
    const resource = await createVocabulary(service, 'PUBLIC');
    await service.attachProvenance(actor('owner-1'), resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'author-later',
      licenseKey: 'LATER-V1',
      attribution: 'Original author',
    });
    await submitCommunityContribution(service, resource.id);
    await service.transitionReview(reviewer, resource.id, 'VERIFIED');
    await expect(service.getPublicResource(resource.id)).resolves.not.toBeNull();

    await service.registerLicense(reviewer, license('LATER-V1', active, redistributionAllowed));
    await expect(service.getPublicResource(resource.id)).resolves.toBeNull();
  });

  it('freezes provenance after submission and verification, and reopens rejected content with an audit note', async () => {
    const { service } = createService();
    const reviewer = actor('moderator-1', ['MODERATOR']);
    await service.registerLicense(reviewer, license('REOPEN-V1'));
    const resource = await createVocabulary(service, 'PUBLIC');
    const original = {
      sourceType: 'ORIGINAL_AUTHOR' as const,
      sourceId: 'author-reopen-1',
      licenseKey: 'REOPEN-V1',
      attribution: 'Original author',
    };
    await service.attachProvenance(actor('owner-1'), resource.id, original);
    await submitCommunityContribution(service, resource.id);

    await expect(service.attachProvenance(actor('owner-1'), resource.id, {
      ...original,
      sourceId: 'author-reopen-2',
    })).rejects.toMatchObject({ code: 'LIBRARY_REVIEW_FORBIDDEN' });

    await service.transitionReview(reviewer, resource.id, 'VERIFIED');
    await expect(service.mergeProvenance(actor('owner-1'), resource.id, [{
      ...original,
      sourceId: 'author-reopen-3',
    }])).rejects.toMatchObject({ code: 'LIBRARY_PROVENANCE_IMMUTABLE' });

    await service.transitionReview(reviewer, resource.id, 'REJECTED', 'Needs provenance correction');
    await expect(service.attachProvenance(reviewer, resource.id, {
      ...original,
      sourceId: 'reviewer-rejected-change',
    })).rejects.toMatchObject({ code: 'LIBRARY_PROVENANCE_IMMUTABLE' });
    await expect(service.transitionReview(reviewer, resource.id, 'DRAFT'))
      .rejects.toMatchObject({ code: 'LIBRARY_REVIEW_NOTE_REQUIRED' });

    const reopened = await service.transitionReview(reviewer, resource.id, 'DRAFT', 'Reopen for provenance correction');
    expect(reopened).toMatchObject({
      resource: { reviewState: 'DRAFT', reviewedByUserId: null, reviewedAt: null },
      audit: { action: 'REOPEN', note: 'Reopen for provenance correction' },
    });
    await service.attachProvenance(actor('owner-1'), resource.id, {
      ...original,
      sourceId: 'author-after-reopen',
    });
    await expect(service.getPublicResource(resource.id)).resolves.toBeNull();
    await submitCommunityContribution(service, resource.id);
    await expect(service.getPublicResource(resource.id)).resolves.toBeNull();
    await service.transitionReview(reviewer, resource.id, 'VERIFIED');
    await expect(service.getPublicResource(resource.id)).resolves.not.toBeNull();
  });

  it('allows a reviewer correction during community review without bypassing verification', async () => {
    const { service } = createService();
    const reviewer = actor('moderator-1', ['MODERATOR']);
    await service.registerLicense(reviewer, license('CORRECTION-V1'));
    const resource = await createVocabulary(service, 'PUBLIC');
    await service.attachProvenance(actor('owner-1'), resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'author-community',
      licenseKey: 'CORRECTION-V1',
      attribution: 'Original author',
    });
    await submitCommunityContribution(service, resource.id);

    await expect(service.attachProvenance(reviewer, resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'reviewer-correction',
      licenseKey: 'CORRECTION-V1',
      attribution: 'Reviewer correction',
    })).resolves.toMatchObject({ sourceId: 'reviewer-correction' });
    await expect(service.getResource(resource.id)).resolves.toMatchObject({ reviewState: 'COMMUNITY_REVIEW' });
  });

  it('binds member original-author provenance to the authenticated actor and keeps the id private', async () => {
    const member = actor(uuid(101));
    const reviewer = actor(uuid(102), ['MODERATOR']);
    const { service } = createService();
    await service.registerLicense(reviewer, license('ACTOR-BOUND-V1', true, true));
    const resource = await service.createDraftResource(member, {
      resourceType: 'VOCABULARY',
      primaryLanguageCode: 'en',
      visibility: 'PUBLIC',
      details: { term: 'word', definition: 'meaning' },
    });

    await service.attachProvenance(member, resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'member-original-1',
      licenseKey: 'ACTOR-BOUND-V1',
      attribution: 'Member attribution',
      originalContributorUserId: member.userId,
    });
    await expect(service.attachProvenance(member, resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'member-original-spoof',
      licenseKey: 'ACTOR-BOUND-V1',
      attribution: 'Spoofed attribution',
      originalContributorUserId: uuid(103),
    })).rejects.toMatchObject({ code: 'LIBRARY_PROVENANCE_SOURCE_FORBIDDEN' });

    expect(await service.getResource(resource.id)).toMatchObject({
      provenance: [{ originalContributorUserId: member.userId }],
    });
    await submitCommunityContribution(service, resource.id, member);
    await service.transitionReview(reviewer, resource.id, 'VERIFIED');
    const publicResource = await service.getPublicResource(resource.id);
    expect(publicResource?.provenance[0]).not.toHaveProperty('originalContributorUserId');
  });

  it('keeps the creator frozen in community review even when the creator is a moderator', async () => {
    const creator = actor(uuid(104), ['MODERATOR']);
    const otherReviewer = actor(uuid(105), ['ADMIN']);
    const { service } = createService();
    await service.registerLicense(otherReviewer, license('CREATOR-MOD-V1'));
    const resource = await service.createDraftResource(creator, {
      resourceType: 'GRAMMAR_ITEM',
      primaryLanguageCode: 'en',
      visibility: 'PUBLIC',
      details: { title: 'Grammar', explanation: 'Explanation' },
    });
    await service.attachProvenance(creator, resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'creator-mod-original',
      licenseKey: 'CREATOR-MOD-V1',
      attribution: 'Creator attribution',
    });
    await service.transitionReview(creator, resource.id, 'COMMUNITY_REVIEW');

    await expect(service.attachProvenance(creator, resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'creator-mod-forbidden',
      licenseKey: 'CREATOR-MOD-V1',
      attribution: 'Creator correction',
    })).rejects.toMatchObject({ code: 'LIBRARY_REVIEW_FORBIDDEN' });
    await expect(service.attachProvenance(otherReviewer, resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'other-reviewer-correction',
      licenseKey: 'CREATOR-MOD-V1',
      attribution: 'Reviewer correction',
    })).resolves.toMatchObject({ sourceId: 'other-reviewer-correction' });
  });

  it('rejects verification when provenance changes after the verifier loaded its revision', async () => {
    const repository = new RevisionRaceRepository();
    const { service } = createService(async () => null, repository);
    const reviewer = actor('moderator-race-1', ['MODERATOR']);
    await service.registerLicense(reviewer, license('RACE-V1', true, true));
    const resource = await createVocabulary(service, 'PUBLIC');
    await service.attachProvenance(actor('owner-1'), resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'race-original',
      licenseKey: 'RACE-V1',
      attribution: 'Original attribution',
    });
    await submitCommunityContribution(service, resource.id);
    const loaded = await service.getResource(resource.id);
    expect(loaded?.provenanceRevision).toBe(1);

    repository.runBeforeNextLicenseLookup(async () => {
      await repository.addProvenance(resource.id, normalizedProvenance('race-concurrent', 'RACE-V1'), {
        expectedReviewState: 'COMMUNITY_REVIEW',
        expectedProvenanceRevision: 1,
      }, new Date());
    });
    await expect(service.transitionReview(reviewer, resource.id, 'VERIFIED'))
      .rejects.toMatchObject({ code: 'LIBRARY_REVIEW_CONFLICT' });
    await expect(service.getResource(resource.id)).resolves.toMatchObject({
      reviewState: 'COMMUNITY_REVIEW',
      provenanceRevision: 2,
    });
  });

  it('rejects stale draft provenance after submit and rejects provenance after verification', async () => {
    const { service, repository } = createService();
    const reviewer = actor('moderator-race-2', ['MODERATOR']);
    await service.registerLicense(reviewer, license('STATE-GUARD-V1', true, true));
    const resource = await createVocabulary(service, 'PUBLIC');
    await service.attachProvenance(actor('owner-1'), resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'state-guard-original',
      licenseKey: 'STATE-GUARD-V1',
      attribution: 'Original attribution',
    });
    const staleDraft = await service.getResource(resource.id);
    await submitCommunityContribution(service, resource.id);
    await expect(repository.addProvenance(
      resource.id,
      normalizedProvenance('stale-draft-mutation', 'STATE-GUARD-V1'),
      {
        expectedReviewState: 'DRAFT',
        expectedProvenanceRevision: staleDraft!.provenanceRevision,
      },
      new Date(),
    )).rejects.toMatchObject({ code: 'LIBRARY_REVIEW_CONFLICT' });
    await expect(service.getResource(resource.id)).resolves.toMatchObject({
      reviewState: 'COMMUNITY_REVIEW',
      provenanceRevision: staleDraft?.provenanceRevision,
    });

    await service.transitionReview(reviewer, resource.id, 'VERIFIED');
    await expect(repository.addProvenance(
      resource.id,
      normalizedProvenance('after-verify', 'STATE-GUARD-V1'),
      {
        expectedReviewState: 'COMMUNITY_REVIEW',
        expectedProvenanceRevision: staleDraft!.provenanceRevision,
      },
      new Date(),
    )).rejects.toMatchObject({ code: 'LIBRARY_PROVENANCE_IMMUTABLE' });
  });

  it('requires a fresh review revision after a reviewer provenance correction', async () => {
    const { service, repository } = createService();
    const reviewer = actor('moderator-race-3', ['MODERATOR']);
    await service.registerLicense(reviewer, license('CORRECTION-RACE-V1', true, true));
    const resource = await createVocabulary(service, 'PUBLIC');
    await service.attachProvenance(actor('owner-1'), resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'correction-race-original',
      licenseKey: 'CORRECTION-RACE-V1',
      attribution: 'Original attribution',
    });
    await submitCommunityContribution(service, resource.id);
    const staleVerifierSnapshot = await service.getResource(resource.id);
    await service.attachProvenance(reviewer, resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'correction-race-reviewer',
      licenseKey: 'CORRECTION-RACE-V1',
      attribution: 'Reviewer correction',
    });

    await expect(repository.transitionReview({
      resourceId: resource.id,
      expectedPreviousState: 'COMMUNITY_REVIEW',
      expectedProvenanceRevision: staleVerifierSnapshot!.provenanceRevision,
      nextState: 'VERIFIED',
      action: 'VERIFY',
      actorUserId: reviewer.userId,
      note: null,
      occurredAt: new Date(),
    })).rejects.toMatchObject({ code: 'LIBRARY_REVIEW_CONFLICT' });
    await expect(service.transitionReview(reviewer, resource.id, 'VERIFIED'))
      .resolves.toMatchObject({ resource: { reviewState: 'VERIFIED' } });
  });

  it('searches only public verified resources and re-checks current redistribution licenses', async () => {
    const { service } = createService();
    const reviewer = actor('search-reviewer-1', ['MODERATOR']);
    await service.registerLicense(reviewer, license('SEARCH-SAFE-V1'));

    const publicResource = await publishSearchResource(service, {
      resourceType: 'VOCABULARY',
      primaryLanguageCode: 'vi',
      visibility: 'PUBLIC',
      topics: ['travel'],
      details: { term: 'từ điển', definition: 'A Vietnamese dictionary' },
      sourceId: 'search-public-1',
    });
    await publishSearchResource(service, {
      resourceType: 'VOCABULARY',
      primaryLanguageCode: 'vi',
      visibility: 'PRIVATE',
      details: { term: 'private', definition: 'Not public' },
      sourceId: 'search-private-1',
    });
    await service.createDraftResource(actor('search-owner-1'), {
      resourceType: 'VOCABULARY',
      primaryLanguageCode: 'vi',
      visibility: 'PUBLIC',
      details: { term: 'draft', definition: 'Not verified' },
    });

    const page = await service.searchPublicResources({ q: 'điển', limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: publicResource.id,
      reviewState: 'VERIFIED',
      preview: { title: 'từ điển' },
      provenance: [{ attribution: 'Search attribution', license: { licenseKey: 'SEARCH-SAFE-V1' } }],
    });
    expect(page.items[0]).not.toHaveProperty('createdByUserId');
    expect(page.items[0]).not.toHaveProperty('reviewedByUserId');

    await service.registerLicense(reviewer, license('SEARCH-SAFE-V1', false, true));
    await expect(service.searchPublicResources({ q: 'điển' })).resolves.toMatchObject({ items: [] });
  });

  it('supports Unicode Vietnamese and CJK keyword search, filters, and deterministic cursors', async () => {
    const { service } = createService();
    const reviewer = actor('search-reviewer-2', ['MODERATOR']);
    await service.registerLicense(reviewer, license('SEARCH-SAFE-V1'));

    const vietnamese = await publishSearchResource(service, {
      resourceType: 'VOCABULARY',
      primaryLanguageCode: 'vi',
      visibility: 'PUBLIC',
      topics: ['daily-life'],
      cefrLevel: 'A1',
      details: { term: 'xin chào', definition: 'A Vietnamese greeting' },
      sourceId: 'search-vietnamese-1',
    });
    const cjk = await publishSearchResource(service, {
      resourceType: 'SENTENCE',
      primaryLanguageCode: 'zh',
      visibility: 'PUBLIC',
      topics: ['daily-life'],
      cefrLevel: 'B1',
      details: { text: '你好，欢迎来到语言社区。', context: 'A greeting' },
      sourceId: 'search-cjk-1',
    });
    const translation = await publishSearchResource(service, {
      resourceType: 'TRANSLATION',
      primaryLanguageCode: 'en',
      secondaryLanguageCode: 'vi',
      visibility: 'PUBLIC',
      topics: ['daily-life'],
      cefrLevel: 'A2',
      details: { sourceText: 'Good morning', translatedText: 'Chào buổi sáng' },
      sourceId: 'search-translation-1',
    });

    await expect(service.searchPublicResources({ q: 'chào' })).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: vietnamese.id })]),
    });
    await expect(service.searchPublicResources({ q: '你好' })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: cjk.id })],
    });
    await expect(service.searchPublicResources({ language: 'vi' })).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: vietnamese.id }),
        expect.objectContaining({ id: translation.id }),
      ]),
    });
    await expect(service.searchPublicResources({ type: 'SENTENCE', topic: 'daily-life', level: 'B1' }))
      .resolves.toMatchObject({ items: [expect.objectContaining({ id: cjk.id })] });

    const first = await service.searchPublicResources({ topic: 'daily-life', limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await service.searchPublicResources({ topic: 'daily-life', limit: 1, cursor: first.nextCursor });
    expect(second.items).toHaveLength(1);
    expect(second.items[0].id).not.toBe(first.items[0].id);
    await expect(service.searchPublicResources({ topic: 'other', limit: 1, cursor: first.nextCursor }))
      .rejects.toMatchObject({ code: 'LIBRARY_INVALID_CURSOR' });
  });

  it('does not treat language codes as keyword content while retaining language filters', async () => {
    const { service } = createService();
    const reviewer = actor('search-reviewer-parity', ['MODERATOR']);
    await service.registerLicense(reviewer, license('SEARCH-SAFE-V1'));

    const languageOnly = await publishSearchResource(service, {
      resourceType: 'VOCABULARY',
      primaryLanguageCode: 'vi',
      visibility: 'PUBLIC',
      topics: ['greetings'],
      details: { term: 'hello', definition: 'greeting' },
      sourceId: 'search-language-only',
    });
    const literalContent = await publishSearchResource(service, {
      resourceType: 'VOCABULARY',
      primaryLanguageCode: 'en',
      visibility: 'PUBLIC',
      topics: ['notation'],
      details: { term: 'vi', definition: 'a literal content token' },
      sourceId: 'search-literal-vi',
    });
    const secondaryLanguage = await publishSearchResource(service, {
      resourceType: 'TRANSLATION',
      primaryLanguageCode: 'en',
      secondaryLanguageCode: 'vi',
      visibility: 'PUBLIC',
      topics: ['greetings'],
      details: { sourceText: 'hello', translatedText: 'xin chào' },
      sourceId: 'search-secondary-vi',
    });

    await expect(service.searchPublicResources({ q: 'vi' })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: literalContent.id })],
    });
    const keywordIds = (await service.searchPublicResources({ q: 'vi' })).items.map((item) => item.id);
    expect(keywordIds).not.toContain(languageOnly.id);
    expect(keywordIds).not.toContain(secondaryLanguage.id);

    await expect(service.searchPublicResources({ language: 'vi' })).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: languageOnly.id }),
        expect.objectContaining({ id: secondaryLanguage.id }),
      ]),
    });
  });

  it('keeps equal-timestamp pages deterministic and duplicate-free', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-22T00:00:00.000Z'));
    try {
      const { service } = createService();
      const reviewer = actor('search-reviewer-tie-breaker', ['MODERATOR']);
      await service.registerLicense(reviewer, license('SEARCH-SAFE-V1'));
      const resources = await Promise.all([
        publishSearchResource(service, {
          resourceType: 'VOCABULARY',
          primaryLanguageCode: 'en',
          visibility: 'PUBLIC',
          topics: ['tie-breaker'],
          details: { term: 'one', definition: 'one' },
          sourceId: 'search-tie-1',
        }),
        publishSearchResource(service, {
          resourceType: 'VOCABULARY',
          primaryLanguageCode: 'en',
          visibility: 'PUBLIC',
          topics: ['tie-breaker'],
          details: { term: 'two', definition: 'two' },
          sourceId: 'search-tie-2',
        }),
        publishSearchResource(service, {
          resourceType: 'VOCABULARY',
          primaryLanguageCode: 'en',
          visibility: 'PUBLIC',
          topics: ['tie-breaker'],
          details: { term: 'three', definition: 'three' },
          sourceId: 'search-tie-3',
        }),
      ]);

      const first = await service.searchPublicResources({ topic: 'tie-breaker', limit: 1 });
      const second = await service.searchPublicResources({ topic: 'tie-breaker', limit: 1, cursor: first.nextCursor });
      const third = await service.searchPublicResources({ topic: 'tie-breaker', limit: 1, cursor: second.nextCursor });
      const pageIds = [first.items[0].id, second.items[0].id, third.items[0].id];

      expect(new Set(pageIds).size).toBe(3);
      expect(pageIds).toEqual(resources.map((resource) => resource.id).sort().reverse());
      expect(third.nextCursor).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('encodes the original ordered-row boundary when hydration observes a newer timestamp', async () => {
    const repository = new HydrationRaceRepository();
    const { service } = createService(undefined, repository);
    const reviewer = actor('search-reviewer-hydration-race', ['MODERATOR']);
    await service.registerLicense(reviewer, license('SEARCH-SAFE-V1'));
    await publishSearchResource(service, {
      resourceType: 'VOCABULARY',
      primaryLanguageCode: 'en',
      visibility: 'PUBLIC',
      topics: ['hydration-race'],
      details: { term: 'first', definition: 'first' },
      sourceId: 'search-hydration-1',
    });
    await publishSearchResource(service, {
      resourceType: 'VOCABULARY',
      primaryLanguageCode: 'en',
      visibility: 'PUBLIC',
      topics: ['hydration-race'],
      details: { term: 'second', definition: 'second' },
      sourceId: 'search-hydration-2',
    });

    const page = await service.searchPublicResources({ topic: 'hydration-race', limit: 1 });
    const cursor = decodeLibrarySearchCursor(page.nextCursor, {
      q: null,
      languageCode: null,
      resourceType: null,
      topic: 'hydration-race',
      cefrLevel: null,
    });

    expect(cursor).toMatchObject({
      updatedAtMicros: '1789948800000000',
      id: page.items[0].id,
    });
    expect(page.items[0].updatedAt).toEqual(new Date('2026-09-22T00:00:00.000Z'));
  });

  it('rejects malformed public search cursors without exposing repository state', async () => {
    const { service } = createService();
    await expect(service.searchPublicResources({ cursor: 'not-a-cursor' }))
      .rejects.toMatchObject({ code: 'LIBRARY_INVALID_CURSOR' });
  });
});

function createService(
  findLibraryCandidateById: (id: string) => Promise<LibraryCandidateRecord | null> = async () => null,
  repository: LibraryRepository = new InMemoryLibraryRepository(),
): {
  service: LibraryService;
  repository: LibraryRepository;
} {
  const profiles = new InMemoryProfileRepository();
  return {
    repository,
    service: new LibraryService(repository, profiles, { findLibraryCandidateById }),
  };
}

class RevisionRaceRepository extends InMemoryLibraryRepository {
  private beforeNextLicenseLookup: (() => Promise<void>) | null = null;

  runBeforeNextLicenseLookup(callback: () => Promise<void>): void {
    this.beforeNextLicenseLookup = callback;
  }

  override async findLicense(licenseKey: string) {
    const callback = this.beforeNextLicenseLookup;
    this.beforeNextLicenseLookup = null;
    if (callback) await callback();
    return super.findLicense(licenseKey);
  }
}

function normalizedProvenance(
  sourceId: string,
  licenseKey: string,
): NormalizedLibraryProvenanceInput {
  return {
    sourceType: 'ORIGINAL_AUTHOR',
    sourceId,
    sourceUrl: null,
    licenseKey,
    attribution: 'Concurrent attribution',
    originalAuthorReference: null,
    originalContributorUserId: null,
    importBatch: null,
    transformationHistory: [],
    sourcePostId: null,
    sourceResponseId: null,
    sourceCandidateId: null,
    sourceAcceptanceId: null,
  };
}

async function createVocabulary(service: LibraryService, visibility?: 'PUBLIC' | 'PRIVATE') {
  return service.createDraftResource(actor('owner-1'), {
    resourceType: 'VOCABULARY',
    primaryLanguageCode: 'en',
    visibility,
    details: { term: 'word', definition: 'meaning' },
  });
}

async function submitCommunityContribution(
  service: LibraryService,
  resourceId: string,
  contributor: LibraryActor = actor('owner-1'),
) {
  return service.submitContribution(contributor, resourceId, {
    termsVersion: 'library-contribution-v1',
    rightsConfirmed: true,
    reuseConsent: true,
  });
}

class HydrationRaceRepository extends InMemoryLibraryRepository {
  override async searchPublicResources(input: Parameters<LibraryRepository['searchPublicResources']>[0]) {
    const page = await super.searchPublicResources(input);
    const first = page.items[0];
    if (!first) return page;
    return {
      ...page,
      items: page.items.map((resource, index) => index === 0
        ? { ...resource, updatedAt: new Date('2026-09-22T00:00:00.000Z') }
        : resource),
      nextBoundary: {
        updatedAtMicros: '1789948800000000',
        id: first.id,
      },
    };
  }
}

async function publishSearchResource(
  service: LibraryService,
  input: {
    resourceType: LibraryResourceType;
    primaryLanguageCode: string;
    secondaryLanguageCode?: string;
    cefrLevel?: string;
    topics?: string[];
    visibility?: 'PUBLIC' | 'PRIVATE';
    details: Record<string, unknown>;
    sourceId: string;
  },
) {
  const resource = await service.createDraftResource(actor('search-owner-1'), input);
  await service.attachProvenance(actor('search-owner-1'), resource.id, {
    sourceType: 'ORIGINAL_AUTHOR',
    sourceId: input.sourceId,
    licenseKey: 'SEARCH-SAFE-V1',
    attribution: 'Search attribution',
  });
  if (input.visibility === 'PUBLIC' && LIBRARY_CONTRIBUTION_RESOURCE_TYPES.includes(resource.resourceType as LibraryContributionResourceType)) {
    await service.submitContribution(actor('search-owner-1'), resource.id, {
      termsVersion: 'library-contribution-v1',
      rightsConfirmed: true,
      reuseConsent: true,
    });
  } else if (input.visibility === 'PUBLIC') {
    await service.transitionReview(actor('search-owner-1'), resource.id, 'COMMUNITY_REVIEW');
  } else {
    return resource;
  }
  await service.transitionReview(actor('search-reviewer-1', ['MODERATOR']), resource.id, 'VERIFIED');
  return resource;
}

function actor(userId: string, roles: LibraryActor['roles'] = ['MEMBER']): LibraryActor {
  return { userId, roles };
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

function uuid(number: number): string {
  return '00000000-0000-4000-8000-' + number.toString().padStart(12, '0');
}

function phase06Candidate(): LibraryCandidateRecord {
  return {
    id: uuid(4),
    sourcePostId: uuid(2),
    sourceResponseId: uuid(3),
    contributorUserId: uuid(6),
    targetLanguageCode: 'en',
    responseKind: 'CORRECTION_PROPOSAL',
    sourceText: 'source',
    correctedText: 'corrected',
    answerText: null,
    explanation: null,
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

function resourceFixtures(): Array<[LibraryResourceType, Record<string, unknown>]> {
  return [
    ['VOCABULARY', { term: 'học', definition: 'to study' }],
    ['SENTENCE', { text: 'Tôi đang học tiếng Việt.' }],
    ['TRANSLATION', { sourceText: 'Hello', translatedText: 'Xin chào' }],
    ['GRAMMAR_ITEM', { title: 'Classifier usage', explanation: 'Use cái for objects.' }],
    ['DIALOGUE', { title: 'Market', turns: [{ speaker: 'A', text: 'Xin chào' }] }],
    ['IDIOM', { expression: 'Nước đến chân mới nhảy', meaning: 'Last-minute action' }],
    ['SLANG', { expression: 'xịn', meaning: 'High quality' }],
    ['CULTURAL_NOTE', { title: 'Tết', body: 'A celebration.' }],
    ['PRONUNCIATION', { term: 'phở', phonetic: '/fɤː/' }],
    ['LEARNING_COLLECTION', { title: 'Travel', description: 'Basics.' }],
  ];
}
