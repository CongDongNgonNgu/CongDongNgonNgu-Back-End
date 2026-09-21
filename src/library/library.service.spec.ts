import { InMemoryProfileRepository } from '../profile/profile.repository';
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
      sourceType: 'MANUAL_ENTRY',
      sourceId: 'manual-1',
      licenseKey: 'UNKNOWN-V1',
      attribution: 'Unknown source',
    })).rejects.toMatchObject({ code: 'LIBRARY_LICENSE_UNKNOWN' });

    await expect(service.attachProvenance(actor('owner-1'), resource.id, {
      sourceType: 'MANUAL_ENTRY',
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
      sourceType: 'COMMUNITY_POST',
      sourceId: 'post-1',
      licenseKey: 'COMMUNITY-V1',
      attribution: 'Community contributor',
    });
    await service.attachProvenance(actor('owner-1'), resource.id, {
      sourceType: 'OPEN_DATASET',
      sourceId: 'dataset-1',
      licenseKey: 'DATASET-V1',
      attribution: 'Dataset attribution',
    });

    await expect(service.attachProvenance(actor('owner-1'), resource.id, {
      sourceType: 'COMMUNITY_POST',
      sourceId: 'post-1',
      licenseKey: 'COMMUNITY-V1',
      attribution: 'Changed attribution',
    })).rejects.toMatchObject({ code: 'LIBRARY_PROVENANCE_DUPLICATE' });

    const merged = await service.mergeProvenance(actor('owner-1'), resource.id, [{
      sourceType: 'COMMUNITY_POST',
      sourceId: 'post-1',
      licenseKey: 'COMMUNITY-V1',
      attribution: 'Community contributor',
    }, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'author-1',
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
    const { service } = createService();
    await service.registerLicense(actor('moderator-1', ['MODERATOR']), license('COMMUNITY-V1'));
    const resource = await createVocabulary(service);
    const provenance = await service.attachProvenance(actor('owner-1'), resource.id, {
      sourceType: 'PHASE06_LIBRARY_CANDIDATE',
      sourceId: 'candidate-1',
      licenseKey: 'COMMUNITY-V1',
      attribution: 'Phase 06 contributor',
      sourcePostId: uuid(2),
      sourceResponseId: uuid(3),
      sourceCandidateId: uuid(4),
      sourceAcceptanceId: uuid(5),
      originalContributorUserId: uuid(6),
    });

    expect(provenance).toMatchObject({
      sourceType: 'PHASE06_LIBRARY_CANDIDATE',
      sourcePostId: uuid(2),
      sourceResponseId: uuid(3),
      sourceCandidateId: uuid(4),
      sourceAcceptanceId: uuid(5),
      originalContributorUserId: uuid(6),
    });
    expect((await service.getResource(resource.id))?.reviewState).toBe('DRAFT');
  });

  it('requires owner submission and denies submitter self-verification', async () => {
    const { service } = createService();
    await service.registerLicense(actor('moderator-1', ['MODERATOR']), license('COMMUNITY-V1'));
    const resource = await createVocabulary(service);
    await service.attachProvenance(actor('owner-1'), resource.id, {
      sourceType: 'MANUAL_ENTRY',
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
      sourceType: 'MANUAL_ENTRY',
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
      sourceType: 'MANUAL_ENTRY',
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
});

function createService(): {
  service: LibraryService;
  repository: LibraryRepository;
} {
  const repository = new InMemoryLibraryRepository();
  const profiles = new InMemoryProfileRepository();
  return {
    repository,
    service: new LibraryService(repository, profiles),
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

function license(licenseKey: string, active = true): LibraryLicenseInput {
  return {
    licenseKey,
    displayName: licenseKey,
    canonicalUrl: 'https://licenses.example.test/' + licenseKey.toLowerCase(),
    attributionRequired: true,
    redistributionAllowed: true,
    active,
  };
}

function uuid(number: number): string {
  return '00000000-0000-4000-8000-' + number.toString().padStart(12, '0');
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
