import { InMemoryProfileRepository } from '../profile/profile.repository';
import type { LibraryCandidateRecord } from '../corrections/corrections.types';
import {
  InMemoryLibraryRepository,
  type LibraryRepository,
} from './library.repository';
import { LibraryService } from './library.service';
import type {
  LibraryActor,
  LibraryLicenseInput,
  LibraryResourceType,
} from './library.types';

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
    const resource = await createVocabulary(service);
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
    await service.transitionReview(actor('owner-1'), resource.id, 'COMMUNITY_REVIEW');

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
    await service.transitionReview(actor('owner-1'), resource.id, 'COMMUNITY_REVIEW');
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
    await service.registerLicense(
      actor('moderator-1', ['MODERATOR']),
      license('UNSAFE-V1', true, redistributionAllowed),
    );
    const resource = await createVocabulary(service, 'PUBLIC');
    await service.attachProvenance(actor('owner-1'), resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'author-unsafe',
      licenseKey: 'UNSAFE-V1',
      attribution: 'Original author',
    });
    await service.transitionReview(actor('owner-1'), resource.id, 'COMMUNITY_REVIEW');

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
    await service.transitionReview(actor('owner-1'), resource.id, 'COMMUNITY_REVIEW');
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
    await service.transitionReview(actor('owner-1'), resource.id, 'COMMUNITY_REVIEW');
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
    await service.transitionReview(actor('owner-1'), resource.id, 'COMMUNITY_REVIEW');

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
    await service.transitionReview(actor('owner-1'), resource.id, 'COMMUNITY_REVIEW');
    await expect(service.getPublicResource(resource.id)).resolves.toBeNull();
    await service.transitionReview(reviewer, resource.id, 'VERIFIED');
    await expect(service.getPublicResource(resource.id)).resolves.not.toBeNull();
  });

  it('allows a reviewer correction during community review without bypassing verification', async () => {
    const { service } = createService();
    const reviewer = actor('moderator-1', ['MODERATOR']);
    await service.registerLicense(reviewer, license('CORRECTION-V1'));
    const resource = await createVocabulary(service);
    await service.attachProvenance(actor('owner-1'), resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'author-community',
      licenseKey: 'CORRECTION-V1',
      attribution: 'Original author',
    });
    await service.transitionReview(actor('owner-1'), resource.id, 'COMMUNITY_REVIEW');

    await expect(service.attachProvenance(reviewer, resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'reviewer-correction',
      licenseKey: 'CORRECTION-V1',
      attribution: 'Reviewer correction',
    })).resolves.toMatchObject({ sourceId: 'reviewer-correction' });
    await expect(service.getResource(resource.id)).resolves.toMatchObject({ reviewState: 'COMMUNITY_REVIEW' });
  });
});

function createService(
  findLibraryCandidateById: (id: string) => Promise<LibraryCandidateRecord | null> = async () => null,
): {
  service: LibraryService;
  repository: LibraryRepository;
} {
  const repository = new InMemoryLibraryRepository();
  const profiles = new InMemoryProfileRepository();
  return {
    repository,
    service: new LibraryService(repository, profiles, { findLibraryCandidateById }),
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
