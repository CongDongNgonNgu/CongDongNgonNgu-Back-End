import { InMemoryProfileRepository } from '../profile/profile.repository';
import { InMemoryLibraryRepository, type LibraryRepository } from './library.repository';
import { LibraryService } from './library.service';
import type { LibraryActor } from './library.types';

describe('LibraryService reviewer read model and actions', () => {
  it('enforces reviewer authorization and returns a bounded pending queue', async () => {
    const { service } = createService();
    const reviewer = actor('reviewer-1', ['MODERATOR']);
    await service.registerLicense(reviewer, license('REVIEW-SAFE'));

    const first = await createGrammar(service, 'owner-1', 'first-word', 'en', 'review-topic-1');
    const second = await createGrammar(service, 'owner-1', 'second-word', 'vi', 'review-topic-2');
    await service.attachProvenance(actor('owner-1'), first.id, provenance('first-source'));
    await service.attachProvenance(actor('owner-1'), second.id, provenance('second-source'));
    await service.transitionReview(actor('owner-1'), first.id, 'COMMUNITY_REVIEW');
    await service.transitionReview(actor('owner-1'), second.id, 'COMMUNITY_REVIEW');

    await expect(service.listReviewQueue(actor('member-1'), {}))
      .rejects.toMatchObject({ code: 'LIBRARY_REVIEW_FORBIDDEN', status: 403 });

    const firstPage = await service.listReviewQueue(reviewer, { limit: 1, type: 'GRAMMAR_ITEM' });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.items[0]).toMatchObject({
      resourceType: 'GRAMMAR_ITEM',
      reviewState: 'COMMUNITY_REVIEW',
      verificationEligibility: { eligible: true, issues: [] },
    });
    expect(firstPage.items[0].provenance[0].license).toMatchObject({
      licenseKey: 'REVIEW-SAFE',
      active: true,
      redistributionAllowed: true,
      eligibleForPublicVerification: true,
    });
    expect(firstPage.items[0].provenance[0].license).not.toHaveProperty('sourceNote');

    const secondPage = await service.listReviewQueue(reviewer, {
      limit: 1,
      type: 'GRAMMAR_ITEM',
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0].resourceId).not.toBe(firstPage.items[0].resourceId);
    expect(secondPage.nextCursor).toBeNull();

    const languagePage = await service.listReviewQueue(reviewer, {
      language: 'vi',
      q: 'second-word',
    });
    expect(languagePage.items.map((item) => item.resourceId)).toEqual([second.id]);
  });

  it('projects reviewer detail without private identity or license registry metadata', async () => {
    const { service } = createService();
    const reviewer = actor('reviewer-2', ['ADMIN']);
    const owner = actor('owner-detail');
    await service.registerLicense(reviewer, license('DETAIL-SAFE', true, true, 'private source note'));
    const resource = await service.createDraftResource(owner, {
      resourceType: 'VOCABULARY',
      primaryLanguageCode: 'en',
      visibility: 'PUBLIC',
      details: { term: 'detail word', definition: 'detail meaning' },
    });
    await service.attachProvenance(owner, resource.id, {
      sourceType: 'ORIGINAL_AUTHOR',
      sourceId: 'detail-source',
      licenseKey: 'DETAIL-SAFE',
      attribution: 'Public contributor label',
    });
    await service.submitContribution(owner, resource.id, {
      termsVersion: 'library-contribution-v1',
      rightsConfirmed: true,
      reuseConsent: true,
    });

    const detail = await service.getReviewDetail(reviewer, resource.id);
    expect(detail.resource).toMatchObject({
      id: resource.id,
      reviewState: 'COMMUNITY_REVIEW',
      visibility: 'PUBLIC',
      details: { term: 'detail word' },
    });
    expect(detail.provenance[0]).toMatchObject({
      attribution: 'Public contributor label',
      license: { licenseKey: 'DETAIL-SAFE', exists: true },
    });
    expect(detail.reviewAuditHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'SUBMIT', newState: 'COMMUNITY_REVIEW' }),
    ]));
    expect(detail.contributionEvents).toEqual([
      expect.objectContaining({
        eventType: 'LIBRARY_CONTRIBUTION_SUBMITTED',
        eventVersion: 1,
        rightsConfirmed: true,
        reuseConsent: true,
      }),
    ]);
    expect(JSON.stringify(detail)).not.toContain('sourceNote');
    expect(JSON.stringify(detail)).not.toContain('contributorUserId');
    expect(JSON.stringify(detail)).not.toContain('email');
    expect(JSON.stringify(detail)).not.toContain('password');
  });

  it('fails verification closed for provenance, license, and moderation eligibility', async () => {
    const reviewer = actor('reviewer-3', ['MODERATOR']);
    const { service } = createService();
    await service.registerLicense(reviewer, license('VERIFY-SAFE'));

    const noProvenance = await createGrammar(service, 'owner-no-provenance', 'no provenance', 'en', 'none');
    await service.transitionReview(actor('owner-no-provenance'), noProvenance.id, 'COMMUNITY_REVIEW');
    await expect(service.transitionReview(reviewer, noProvenance.id, 'VERIFIED'))
      .rejects.toMatchObject({ code: 'LIBRARY_PROVENANCE_REQUIRED' });

    const disabled = await createGrammar(service, 'owner-disabled', 'disabled', 'en', 'disabled');
    await service.attachProvenance(actor('owner-disabled'), disabled.id, provenance('disabled-source', 'VERIFY-SAFE'));
    await service.registerLicense(reviewer, license('VERIFY-SAFE', false));
    await service.transitionReview(actor('owner-disabled'), disabled.id, 'COMMUNITY_REVIEW');
    await expect(service.transitionReview(reviewer, disabled.id, 'VERIFIED'))
      .rejects.toMatchObject({ code: 'LIBRARY_LICENSE_DISABLED' });

    await service.registerLicense(reviewer, license('VERIFY-SAFE'));
    const hiddenRepository = new HiddenReviewRepository();
    const hiddenService = createService(hiddenRepository).service;
    await hiddenService.registerLicense(reviewer, license('HIDDEN-SAFE'));
    const hidden = await createGrammar(hiddenService, 'owner-hidden', 'hidden', 'en', 'hidden');
    await hiddenService.attachProvenance(actor('owner-hidden'), hidden.id, provenance('hidden-source', 'HIDDEN-SAFE'));
    await hiddenService.transitionReview(actor('owner-hidden'), hidden.id, 'COMMUNITY_REVIEW');
    hiddenRepository.markHidden(hidden.id);
    await expect(hiddenService.transitionReview(reviewer, hidden.id, 'VERIFIED'))
      .rejects.toMatchObject({ code: 'LIBRARY_REVIEW_MODERATION_INACTIVE' });
    await expect(hiddenService.getResource(hidden.id)).resolves.toMatchObject({ reviewState: 'COMMUNITY_REVIEW' });
  });

  it('denies self-verification even when the creator is a reviewer', async () => {
    const creatorReviewer = actor('creator-reviewer', ['ADMIN']);
    const { service } = createService();
    await service.registerLicense(creatorReviewer, license('SELF-SAFE'));
    const resource = await createGrammar(service, 'creator-reviewer', 'self', 'en', 'self');
    await service.attachProvenance(creatorReviewer, resource.id, provenance('self-source', 'SELF-SAFE'));
    await service.transitionReview(creatorReviewer, resource.id, 'COMMUNITY_REVIEW');

    await expect(service.transitionReview(creatorReviewer, resource.id, 'VERIFIED'))
      .rejects.toMatchObject({ code: 'LIBRARY_SELF_VERIFICATION_DENIED', status: 403 });
    await expect(service.getResource(resource.id)).resolves.toMatchObject({ reviewState: 'COMMUNITY_REVIEW' });
  });

  it('keeps reject atomic at the service boundary and requires a note', async () => {
    const reviewer = actor('reviewer-reject', ['MODERATOR']);
    const { service } = createService();
    await service.registerLicense(reviewer, license('REJECT-SAFE'));
    const resource = await createGrammar(service, 'owner-reject', 'reject', 'en', 'reject');
    await service.attachProvenance(actor('owner-reject'), resource.id, provenance('reject-source', 'REJECT-SAFE'));
    await service.transitionReview(actor('owner-reject'), resource.id, 'COMMUNITY_REVIEW');

    await expect(service.transitionReview(reviewer, resource.id, 'REJECTED'))
      .rejects.toMatchObject({ code: 'LIBRARY_REVIEW_NOTE_REQUIRED' });
    await expect(service.transitionReview(reviewer, resource.id, 'REJECTED', 'Needs correction'))
      .resolves.toMatchObject({ resource: { reviewState: 'REJECTED' }, audit: { action: 'REJECT' } });
    await expect(service.listReviewQueue(reviewer, {})).resolves.toMatchObject({ items: [] });
    await expect(service.getPublicResource(resource.id)).resolves.toBeNull();
  });
});

function createService(repository: LibraryRepository = new InMemoryLibraryRepository()) {
  return {
    repository,
    service: new LibraryService(
      repository,
      new InMemoryProfileRepository(),
      { findLibraryCandidateById: async () => null },
    ),
  };
}

async function createGrammar(
  service: LibraryService,
  ownerId: string,
  title: string,
  language: string,
  topic: string,
) {
  return service.createDraftResource(actor(ownerId), {
    resourceType: 'GRAMMAR_ITEM',
    primaryLanguageCode: language,
    visibility: 'PUBLIC',
    topics: [topic],
    details: { title, explanation: `${title} explanation` },
  });
}

function actor(userId: string, roles: LibraryActor['roles'] = ['MEMBER']): LibraryActor {
  return { userId, roles };
}

function license(
  licenseKey: string,
  active = true,
  redistributionAllowed: boolean | null = true,
  sourceNote = 'private source note',
) {
  return {
    licenseKey,
    displayName: `${licenseKey} display`,
    canonicalUrl: `https://licenses.example.test/${licenseKey.toLowerCase()}`,
    attributionRequired: true,
    redistributionAllowed,
    derivativeConstraints: 'Share alike',
    active,
    sourceNote,
  };
}

function provenance(sourceId: string, licenseKey = 'REVIEW-SAFE') {
  return {
    sourceType: 'ORIGINAL_AUTHOR',
    sourceId,
    licenseKey,
    attribution: 'Public contributor',
  };
}

class HiddenReviewRepository extends InMemoryLibraryRepository {
  private readonly hidden = new Set<string>();

  markHidden(resourceId: string): void {
    this.hidden.add(resourceId);
  }

  override async findResourceById(id: string) {
    const resource = await super.findResourceById(id);
    if (!resource || !this.hidden.has(id)) return resource;
    return { ...resource, moderationState: 'HIDDEN' as const };
  }
}
