import { Inject, Injectable } from '@nestjs/common';
import { CORRECTIONS_REPOSITORY } from '../corrections/corrections.repository';
import type { CorrectionsRepository } from '../corrections/corrections.repository';
import { PROFILE_REPOSITORY } from '../profile/profile.repository';
import type { ProfileRepository } from '../profile/profile.repository';
import {
  assertLibraryReviewTransition,
  LibraryValidationError,
  normalizeLibraryLicenseInput,
  normalizeLibraryInvalidSourceQueueInput,
  normalizeLibraryReviewQueueInput,
  normalizeLibrarySearchInput,
  normalizeLibraryProvenanceInput,
  normalizeLibraryResourceInput,
  normalizeReviewState,
} from './library.normalization';
import { LibraryFailure, libraryFailure } from './library.errors';
import { decodeLibrarySearchCursor, encodeLibrarySearchCursor } from './library.pagination';
import { toLibrarySearchPreview, toPublicSearchResult } from './library.search';
import {
  LIBRARY_CONTRIBUTION_RESOURCE_TYPES,
  LIBRARY_CONTRIBUTION_TERMS_VERSION,
} from './library.types';
import {
  LIBRARY_REPOSITORY,
  LibraryRepositoryConflictError,
  type LibraryRepository,
} from './library.repository';
import type {
  CreateLibraryResourceInput,
  LibraryActor,
  LibraryContributionEventRecord,
  LibraryContributionPolicy,
  LibraryContributionResourceType,
  LibraryLicenseInput,
  LibraryLicenseRecord,
  LibraryPublicResource,
  LibraryPublicSearchPage,
  LibraryPublicProvenance,
  LibraryProvenanceInput,
  LibraryProvenanceRecord,
  LibraryResourceRecord,
  LibraryReviewContributionEventSummary,
  LibraryReviewDetail,
  LibraryReviewEligibility,
  LibraryReviewEligibilityIssue,
  LibraryReviewLicenseSummary,
  LibraryReviewProvenanceSummary,
  LibraryReviewQueueItem,
  LibraryReviewQueuePage,
  LibraryReviewQueueInput,
  LibraryInvalidSourceQueueInput,
  LibraryInvalidSourceQueuePage,
  LibrarySourceHealth,
  LibrarySearchInput,
  LibraryReviewAuditRecord,
  LibraryContributionSubmissionResult,
  SubmitLibraryContributionInput,
  NormalizedLibraryLicenseInput,
  NormalizedLibraryProvenanceInput,
} from './library.types';
import type {
  Phase06SourceReference,
  Phase06SourceHealth,
} from '../corrections/corrections.source-health';

@Injectable()
export class LibraryService {
  constructor(
    @Inject(LIBRARY_REPOSITORY) private readonly repository: LibraryRepository,
    @Inject(PROFILE_REPOSITORY) private readonly profiles: ProfileRepository,
    @Inject(CORRECTIONS_REPOSITORY)
    private readonly corrections: Pick<CorrectionsRepository, 'findLibraryCandidateById'> & {
      inspectLibraryCandidateSource?: (
        reference: Phase06SourceReference,
      ) => Promise<Phase06SourceHealth>;
    },
  ) {}

  async registerLicense(
    actor: LibraryActor,
    input: LibraryLicenseInput,
  ): Promise<LibraryLicenseRecord> {
    this.requireReviewer(actor);
    const normalized = this.normalize(() => normalizeLibraryLicenseInput(input));
    return this.repository.upsertLicense(normalized);
  }

  async findLicense(licenseKey: unknown): Promise<LibraryLicenseRecord | null> {
    if (typeof licenseKey !== 'string') {
      libraryFailure('LIBRARY_LICENSE_INVALID', 'The library license key is invalid');
    }
    const normalized = licenseKey.normalize('NFKC').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]{0,79}$/u.test(normalized)) {
      libraryFailure('LIBRARY_LICENSE_INVALID', 'The library license key is invalid');
    }
    return this.repository.findLicense(normalized);
  }

  async getContributionPolicy(): Promise<LibraryContributionPolicy> {
    const licenses = await this.repository.listLicenses();
    return {
      termsVersion: LIBRARY_CONTRIBUTION_TERMS_VERSION,
      approvedResourceTypes: [...LIBRARY_CONTRIBUTION_RESOURCE_TYPES],
      licenses: licenses
        .filter((license) => license.active && license.redistributionAllowed === true)
        .map((license) => ({
          licenseKey: license.licenseKey,
          displayName: license.displayName,
          canonicalUrl: license.canonicalUrl,
          attributionRequired: license.attributionRequired,
          redistributionAllowed: true as const,
          derivativeConstraints: license.derivativeConstraints,
        })),
    };
  }

  async createDraftResource(
    actor: LibraryActor,
    input: CreateLibraryResourceInput,
  ): Promise<LibraryResourceRecord> {
    this.requireActor(actor);
    const normalized = this.normalize(() => normalizeLibraryResourceInput(input));
    await this.requireActiveLanguages([
      normalized.primaryLanguageCode,
      ...(normalized.secondaryLanguageCode ? [normalized.secondaryLanguageCode] : []),
    ]);

    try {
      return await this.repository.createResource({
        ...normalized,
        createdByUserId: actor.userId,
        createdAt: new Date(),
      });
    } catch (error) {
      throw this.mapRepositoryError(error);
    }
  }

  async getResource(resourceId: string): Promise<LibraryResourceRecord | null> {
    return this.repository.findResourceById(resourceId);
  }

  async attachProvenance(
    actor: LibraryActor,
    resourceId: string,
    input: LibraryProvenanceInput,
  ): Promise<LibraryProvenanceRecord> {
    this.requireActor(actor);
    const resource = await this.requireResource(resourceId);
    this.requireProvenanceEditor(actor, resource);
    const normalized = this.bindSourceAuthority(
      actor,
      this.normalize(() => normalizeLibraryProvenanceInput(input)),
    );
    await this.requireSourceIntegrity(normalized);
    await this.requireActiveLicense(normalized.licenseKey);

    try {
      return await this.repository.addProvenance(resourceId, normalized, {
        expectedReviewState: resource.reviewState,
        expectedProvenanceRevision: resource.provenanceRevision,
      }, new Date());
    } catch (error) {
      throw this.mapRepositoryError(error);
    }
  }

  async mergeProvenance(
    actor: LibraryActor,
    resourceId: string,
    inputs: readonly LibraryProvenanceInput[],
  ): Promise<LibraryProvenanceRecord[]> {
    this.requireActor(actor);
    const resource = await this.requireResource(resourceId);
    this.requireProvenanceEditor(actor, resource);
    const normalized = inputs.map((input) => this.bindSourceAuthority(
      actor,
      this.normalize(() => normalizeLibraryProvenanceInput(input)),
    ));
    for (const entry of normalized) {
      await this.requireSourceIntegrity(entry);
    }
    for (const entry of normalized) await this.requireActiveLicense(entry.licenseKey);

    try {
      return await this.repository.mergeProvenance(resourceId, normalized, {
        expectedReviewState: resource.reviewState,
        expectedProvenanceRevision: resource.provenanceRevision,
      }, new Date());
    } catch (error) {
      throw this.mapRepositoryError(error);
    }
  }

  async transitionReview(
    actor: LibraryActor,
    resourceId: string,
    nextStateInput: unknown,
    note?: unknown,
  ): Promise<{ resource: LibraryResourceRecord; audit: LibraryReviewAuditRecord }> {
    this.requireActor(actor);
    const resource = await this.requireResource(resourceId);
    const nextState = this.normalize(() => normalizeReviewState(nextStateInput));
    if (
      resource.reviewState === 'REJECTED' &&
      nextState === 'VERIFIED'
    ) {
      libraryFailure(
        'LIBRARY_REVIEW_CONFLICT',
        'The resource has already left the reviewer queue',
        409,
      );
    }
    const action = this.normalize(() => assertLibraryReviewTransition(resource.reviewState, nextState));

    if (action === 'SUBMIT') {
      if (resource.createdByUserId !== actor.userId) {
        libraryFailure('LIBRARY_SUBMIT_FORBIDDEN', 'Only the resource creator can submit a draft for review', 403);
      }
      if (LIBRARY_CONTRIBUTION_RESOURCE_TYPES.includes(resource.resourceType as LibraryContributionResourceType)) {
        libraryFailure(
          'LIBRARY_CONTRIBUTION_SUBMIT_REQUIRED',
          'This resource type must be submitted through the community contribution flow',
          409,
        );
      }
    } else {
      this.requireReviewer(actor);
      if (action === 'VERIFY' && resource.createdByUserId === actor.userId) {
        libraryFailure('LIBRARY_SELF_VERIFICATION_DENIED', 'A submitter cannot verify their own resource', 403);
      }
      if (action === 'VERIFY') {
        if (resource.moderationState !== 'ACTIVE') {
          libraryFailure(
            'LIBRARY_REVIEW_MODERATION_INACTIVE',
            'Only actively moderated resources can be verified',
            409,
          );
        }
        if (resource.provenance.length === 0) {
          libraryFailure('LIBRARY_PROVENANCE_REQUIRED', 'A resource needs provenance before verification');
        }
        await this.requireCurrentProvenanceLicenses(resource, resource.visibility === 'PUBLIC');
        const sourceHealth = await this.evaluateProvenanceSourceHealth(resource.provenance);
        if (sourceHealth.some((entry) => entry.applicable && !entry.valid)) {
          libraryFailure(
            'LIBRARY_SOURCE_INVALID',
            'A Phase 06 source is no longer eligible for verification',
            409,
          );
        }
      }
    }

    const normalizedNote = this.normalizeReviewNote(
      note,
      action === 'REJECT' || action === 'INVALIDATE' || action === 'REOPEN',
    );
    try {
      return await this.repository.transitionReview({
        resourceId,
        expectedPreviousState: resource.reviewState,
        expectedProvenanceRevision: resource.provenanceRevision,
        nextState,
        action,
        actorUserId: actor.userId,
        note: normalizedNote,
        occurredAt: new Date(),
      });
    } catch (error) {
      throw this.mapRepositoryError(error);
    }
  }

  async submitContribution(
    actor: LibraryActor,
    resourceId: string,
    input: SubmitLibraryContributionInput,
  ): Promise<LibraryContributionSubmissionResult> {
    this.requireActor(actor);
    const submission = input && typeof input === 'object' ? input : {};
    const resource = await this.requireResource(resourceId);
    if (resource.createdByUserId !== actor.userId) {
      libraryFailure('LIBRARY_SUBMIT_FORBIDDEN', 'Only the resource creator can submit a contribution', 403);
    }
    if (resource.reviewState !== 'DRAFT') {
      libraryFailure(
        'LIBRARY_CONTRIBUTION_CONFLICT',
        'The library contribution is no longer an editable draft',
        409,
      );
    }
    if (!LIBRARY_CONTRIBUTION_RESOURCE_TYPES.includes(resource.resourceType as LibraryContributionResourceType)) {
      libraryFailure(
        'LIBRARY_CONTRIBUTION_TYPE_FORBIDDEN',
        'This resource type is not approved for community contribution',
      );
    }
    if (resource.visibility !== 'PUBLIC') {
      libraryFailure(
        'LIBRARY_CONTRIBUTION_PUBLIC_REQUIRED',
        'Community contributions must be public before submission',
      );
    }
    if (resource.moderationState !== 'ACTIVE') {
      libraryFailure(
        'LIBRARY_CONTRIBUTION_MODERATION_REQUIRED',
        'The resource must be active before community submission',
        409,
      );
    }
    if (resource.provenance.length === 0) {
      libraryFailure('LIBRARY_PROVENANCE_REQUIRED', 'A contribution requires provenance before submission');
    }
    if (resource.provenance.some((entry) => (
      entry.sourceType !== 'ORIGINAL_AUTHOR' ||
      entry.originalContributorUserId !== actor.userId
    ))) {
      libraryFailure(
        'LIBRARY_CONTRIBUTION_PROVENANCE_FORBIDDEN',
        'Every contribution provenance entry must be bound to the authenticated original contributor',
      );
    }
    await this.requireCurrentProvenanceLicenses(resource, true);
    this.requireContributionTerms(submission.termsVersion);
    this.requireContributionConsent(submission.rightsConfirmed, 'rights');
    this.requireContributionConsent(submission.reuseConsent, 'reuse');

    try {
      return await this.repository.submitContribution({
        resourceId,
        expectedProvenanceRevision: resource.provenanceRevision,
        contributorUserId: actor.userId,
        resourceType: resource.resourceType as LibraryContributionResourceType,
        termsVersion: LIBRARY_CONTRIBUTION_TERMS_VERSION,
        rightsConfirmed: true,
        reuseConsent: true,
        occurredAt: new Date(),
      });
    } catch (error) {
      throw this.mapRepositoryError(error);
    }
  }

  async listReviewQueue(
    actor: LibraryActor,
    input: LibraryReviewQueueInput,
  ): Promise<LibraryReviewQueuePage> {
    this.requireReviewer(actor);
    const normalized = this.normalize(() => normalizeLibraryReviewQueueInput(input));
    const searchFilters = {
      q: normalized.filters.q,
      languageCode: normalized.filters.languageCode,
      resourceType: normalized.filters.resourceType,
      topic: null,
      cefrLevel: null,
    } as const;
    let cursor;
    try {
      cursor = decodeLibrarySearchCursor(normalized.cursor, searchFilters);
    } catch (error) {
      if (error instanceof LibraryValidationError) {
        libraryFailure(error.code, 'The library review pagination cursor is invalid');
      }
      throw error;
    }
    if (normalized.filters.languageCode) {
      await this.requireActiveLanguages([normalized.filters.languageCode]);
    }

    const page = await this.repository.listReviewQueue({
      filters: normalized.filters,
      cursor,
      limit: normalized.limit,
    });
    const items = await Promise.all(page.items.map((resource) => this.projectReviewQueueItem(resource)));
    return {
      items,
      nextCursor: page.hasMore && page.nextBoundary
        ? encodeLibrarySearchCursor(page.nextBoundary, searchFilters)
        : null,
    };
  }

  async listInvalidSourceQueue(
    actor: LibraryActor,
    input: LibraryInvalidSourceQueueInput,
  ): Promise<LibraryInvalidSourceQueuePage> {
    this.requireReviewer(actor);
    const normalized = this.normalize(() => normalizeLibraryInvalidSourceQueueInput(input));
    const cursorFilters = {
      q: null,
      languageCode: null,
      resourceType: null,
      topic: null,
      cefrLevel: null,
    } as const;
    let cursor;
    try {
      cursor = decodeLibrarySearchCursor(normalized.cursor, cursorFilters);
    } catch (error) {
      if (error instanceof LibraryValidationError) {
        libraryFailure(error.code, 'The invalid-source review pagination cursor is invalid');
      }
      throw error;
    }
    const page = await this.repository.listInvalidSourceQueue({
      cursor,
      limit: normalized.limit,
    });
    const items: LibraryInvalidSourceQueuePage['items'] = [];
    for (const resource of page.items) {
      if (resource.reviewState !== 'VERIFIED') continue;
      const provenance = await this.projectReviewProvenance(resource.provenance);
      const sourceHealth = provenance
        .filter((entry) => entry.sourceHealth.applicable)
        .map((entry) => entry.sourceHealth);
      if (!sourceHealth.some((entry) => !entry.valid)) continue;
      items.push({
        resourceId: resource.id,
        resourceType: resource.resourceType,
        primaryLanguageCode: resource.primaryLanguageCode,
        secondaryLanguageCode: resource.secondaryLanguageCode,
        preview: toLibrarySearchPreview(resource.details),
        reviewState: 'VERIFIED',
        updatedAt: new Date(resource.updatedAt),
        provenanceRevision: resource.provenanceRevision,
        sourceHealth,
        publicExposure: false,
      });
    }
    return {
      items,
      nextCursor: page.hasMore && page.nextBoundary
        ? encodeLibrarySearchCursor(page.nextBoundary, cursorFilters)
        : null,
    };
  }

  async getReviewDetail(
    actor: LibraryActor,
    resourceId: string,
  ): Promise<LibraryReviewDetail> {
    this.requireReviewer(actor);
    const resource = await this.requireResource(resourceId);
    const [auditHistory, contributionEvents, provenance] = await Promise.all([
      this.repository.listReviewAudit(resourceId),
      this.repository.listContributionEvents(resourceId),
      this.projectReviewProvenance(resource.provenance),
    ]);
    return {
      resource: {
        id: resource.id,
        resourceType: resource.resourceType,
        primaryLanguageCode: resource.primaryLanguageCode,
        secondaryLanguageCode: resource.secondaryLanguageCode,
        cefrLevel: resource.cefrLevel,
        topics: [...resource.topics],
        visibility: resource.visibility,
        moderationState: resource.moderationState,
        reviewState: resource.reviewState,
        createdAt: new Date(resource.createdAt),
        updatedAt: new Date(resource.updatedAt),
        provenanceRevision: resource.provenanceRevision,
        details: cloneDetails(resource.details),
      },
      provenance,
      reviewAuditHistory: auditHistory.map((audit) => ({
        ...audit,
        createdAt: new Date(audit.createdAt),
      })),
      contributionEvents: contributionEvents.map(toReviewContributionEvent),
      verificationEligibility: this.calculateReviewEligibility(resource, provenance),
    };
  }

  async reconcileSource(
    actor: LibraryActor,
    resourceId: string,
    note?: unknown,
  ): Promise<{ resource: LibraryResourceRecord; audit: LibraryReviewAuditRecord }> {
    this.requireReviewer(actor);
    const resource = await this.requireResource(resourceId);
    if (resource.reviewState !== 'VERIFIED') {
      libraryFailure(
        'LIBRARY_REVIEW_CONFLICT',
        'Only a verified resource can be reconciled against its Phase 06 source',
        409,
      );
    }
    const sourceHealth = await this.evaluateProvenanceSourceHealth(resource.provenance);
    const invalidReasons = sourceHealth
      .filter((entry) => entry.applicable && !entry.valid)
      .map((entry) => entry.reason);
    if (invalidReasons.length === 0) {
      libraryFailure(
        'LIBRARY_SOURCE_STILL_VALID',
        'The Phase 06 source is currently valid',
        409,
      );
    }
    const reviewerNote = this.normalizeReviewNote(note, false);
    const reasonNote = `Phase 06 source invalid: ${[...new Set(invalidReasons)].join(', ')}`;
    const reconciliationNote = reviewerNote
      ? `${reasonNote} — ${reviewerNote}`.slice(0, 2_000)
      : reasonNote;
    try {
      return await this.repository.reconcileSource({
        resourceId,
        expectedPreviousState: 'VERIFIED',
        expectedProvenanceRevision: resource.provenanceRevision,
        actorUserId: actor.userId,
        note: reconciliationNote,
        sourceReasons: invalidReasons,
        occurredAt: new Date(),
      });
    } catch (error) {
      throw this.mapRepositoryError(error);
    }
  }

  async listReviewAudit(
    actor: LibraryActor,
    resourceId: string,
  ): Promise<LibraryReviewAuditRecord[]> {
    const resource = await this.requireResource(resourceId);
    this.requireResourceEditor(actor, resource);
    return this.repository.listReviewAudit(resourceId);
  }

  async getPublicResource(resourceId: string): Promise<LibraryPublicResource | null> {
    const resource = await this.repository.findResourceById(resourceId);
    return this.projectPublicResource(resource);
  }

  async searchPublicResources(input: LibrarySearchInput): Promise<LibraryPublicSearchPage> {
    const normalized = this.normalize(() => normalizeLibrarySearchInput(input));
    let cursor;
    try {
      cursor = decodeLibrarySearchCursor(normalized.cursor, normalized.filters);
    } catch (error) {
      if (error instanceof LibraryValidationError) {
        libraryFailure(error.code, 'The library pagination cursor is invalid');
      }
      throw error;
    }
    if (normalized.filters.languageCode) {
      await this.requireActiveLanguages([normalized.filters.languageCode]);
    }

    const page = await this.repository.searchPublicResources({
      filters: normalized.filters,
      cursor,
      limit: normalized.limit,
    });
    const items = [];
    for (const resource of page.items) {
      const publicResource = await this.projectPublicSearchResult(resource);
      if (publicResource) items.push(publicResource);
    }
    return {
      items,
      nextCursor: page.hasMore && page.nextBoundary
        ? encodeLibrarySearchCursor(
          page.nextBoundary,
          normalized.filters,
        )
        : null,
    };
  }

  private async projectPublicResource(
    resource: LibraryResourceRecord | null,
  ): Promise<LibraryPublicResource | null> {
    if (
      !resource ||
      resource.reviewState !== 'VERIFIED' ||
      resource.visibility !== 'PUBLIC' ||
      resource.moderationState !== 'ACTIVE' ||
      resource.provenance.length === 0
    ) {
      return null;
    }
    const provenance = await this.refreshProvenanceLicenses(resource.provenance);
    if (
      !provenance ||
      provenance.some((entry) => (
        !entry.license.active || entry.license.redistributionAllowed !== true
      ))
    ) return null;
    const sourceHealth = await this.evaluateProvenanceSourceHealth(provenance);
    if (sourceHealth.some((entry) => entry.applicable && !entry.valid)) return null;

    return {
      id: resource.id,
      resourceType: resource.resourceType,
      primaryLanguageCode: resource.primaryLanguageCode,
      secondaryLanguageCode: resource.secondaryLanguageCode,
      cefrLevel: resource.cefrLevel,
      topics: [...resource.topics],
      reviewState: 'VERIFIED',
      details: cloneDetails(resource.details),
      provenance: provenance.map(toPublicProvenance),
      createdAt: new Date(resource.createdAt),
      updatedAt: new Date(resource.updatedAt),
    };
  }

  private async projectPublicSearchResult(resource: LibraryResourceRecord) {
    if (
      resource.reviewState !== 'VERIFIED' ||
      resource.visibility !== 'PUBLIC' ||
      resource.moderationState !== 'ACTIVE' ||
      resource.provenance.length === 0
    ) return null;
    const provenance = await this.refreshProvenanceLicenses(resource.provenance);
    if (
      !provenance ||
      provenance.some((entry) => (
        !entry.license.active || entry.license.redistributionAllowed !== true
      ))
    ) return null;
    const sourceHealth = await this.evaluateProvenanceSourceHealth(provenance);
    if (sourceHealth.some((entry) => entry.applicable && !entry.valid)) return null;
    return toPublicSearchResult(resource, provenance);
  }

  private async projectReviewQueueItem(
    resource: LibraryResourceRecord,
  ): Promise<LibraryReviewQueueItem> {
    const provenance = await this.projectReviewProvenance(resource.provenance);
    return {
      resourceId: resource.id,
      resourceType: resource.resourceType,
      primaryLanguageCode: resource.primaryLanguageCode,
      secondaryLanguageCode: resource.secondaryLanguageCode,
      cefrLevel: resource.cefrLevel,
      topics: [...resource.topics],
      reviewState: 'COMMUNITY_REVIEW',
      preview: toLibrarySearchPreview(resource.details),
      updatedAt: new Date(resource.updatedAt),
      provenanceRevision: resource.provenanceRevision,
      provenance,
      verificationEligibility: this.calculateReviewEligibility(resource, provenance),
    };
  }

  private async projectReviewProvenance(
    provenance: readonly LibraryProvenanceRecord[],
  ): Promise<LibraryReviewProvenanceSummary[]> {
    return Promise.all(provenance.map(async (entry) => {
      const [license, sourceHealth] = await Promise.all([
        this.repository.findLicense(entry.licenseKey),
        this.evaluateProvenanceSourceHealth([entry]).then((items) => items[0]),
      ]);
      return {
        id: entry.id,
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        sourceUrl: entry.sourceUrl,
        attribution: entry.attribution,
        originalAuthorReference: entry.originalAuthorReference,
        license: toReviewLicenseSummary(license, entry.licenseKey),
        sourceHealth,
      };
    }));
  }

  private calculateReviewEligibility(
    resource: LibraryResourceRecord,
    provenance: readonly LibraryReviewProvenanceSummary[],
  ): LibraryReviewEligibility {
    const issues: LibraryReviewEligibilityIssue[] = [];
    if (provenance.length === 0) issues.push('PROVENANCE_REQUIRED');
    for (const entry of provenance) {
      if (!entry.license.exists) {
        issues.push('LICENSE_UNKNOWN');
      } else if (!entry.license.active) {
        issues.push('LICENSE_INACTIVE');
      }
      if (
        resource.visibility === 'PUBLIC' &&
        entry.license.redistributionAllowed !== true
      ) {
        issues.push('LICENSE_REDISTRIBUTION_UNSAFE');
      }
      if (entry.sourceHealth.applicable && !entry.sourceHealth.valid) {
        issues.push('SOURCE_INVALID');
      }
    }
    if (resource.moderationState !== 'ACTIVE') issues.push('MODERATION_INACTIVE');
    const uniqueIssues = [...new Set(issues)];
    return {
      eligible: uniqueIssues.length === 0,
      issues: uniqueIssues,
    };
  }

  private async requireActiveLanguages(codes: readonly string[]): Promise<void> {
    const uniqueCodes = [...new Set(codes)];
    const languages = await this.profiles.findActiveByCodes(uniqueCodes);
    if (languages.length !== uniqueCodes.length) {
      libraryFailure('LIBRARY_LANGUAGE_UNAVAILABLE', 'One or more library languages are unavailable');
    }
  }

  private async requireActiveLicense(licenseKey: string): Promise<LibraryLicenseRecord> {
    const license = await this.repository.findLicense(licenseKey);
    if (!license) libraryFailure('LIBRARY_LICENSE_UNKNOWN', 'The referenced library license is not registered');
    if (!license.active) libraryFailure('LIBRARY_LICENSE_DISABLED', 'The referenced library license is disabled');
    return license;
  }

  private async evaluateProvenanceSourceHealth(
    provenance: readonly LibraryProvenanceRecord[],
  ): Promise<LibrarySourceHealth[]> {
    return Promise.all(provenance.map(async (entry) => {
      if (entry.sourceType !== 'PHASE06_LIBRARY_CANDIDATE') {
        return {
          applicable: false,
          valid: true,
          reason: 'NOT_APPLICABLE' as const,
        };
      }
      if (
        !entry.sourcePostId ||
        !entry.sourceResponseId ||
        !entry.sourceCandidateId ||
        !entry.sourceAcceptanceId ||
        entry.sourceId !== entry.sourceCandidateId
      ) {
        return {
          applicable: true,
          valid: false,
          reason: 'SOURCE_REFERENCE_MISMATCH' as const,
        };
      }
      const reference: Phase06SourceReference = {
        sourceId: entry.sourceId,
        sourcePostId: entry.sourcePostId,
        sourceResponseId: entry.sourceResponseId,
        sourceCandidateId: entry.sourceCandidateId,
        sourceAcceptanceId: entry.sourceAcceptanceId,
      };
      if (this.corrections.inspectLibraryCandidateSource) {
        const health = await this.corrections.inspectLibraryCandidateSource(reference);
        return {
          applicable: true,
          valid: health.valid,
          reason: health.reason,
        };
      }
      const candidate = await this.corrections.findLibraryCandidateById(entry.sourceCandidateId);
      return candidate &&
        candidate.state === 'PENDING_REVIEW' &&
        candidate.sourcePostId === entry.sourcePostId &&
        candidate.sourceResponseId === entry.sourceResponseId &&
        candidate.acceptanceId === entry.sourceAcceptanceId
        ? { applicable: true, valid: true, reason: 'VALID' as const }
        : { applicable: true, valid: false, reason: 'CANDIDATE_MISSING' as const };
    }));
  }

  private async requireCurrentProvenanceLicenses(
    resource: LibraryResourceRecord,
    requireRedistribution: boolean,
  ): Promise<LibraryProvenanceRecord[]> {
    const provenance = await this.refreshProvenanceLicenses(resource.provenance);
    if (!provenance) {
      libraryFailure('LIBRARY_LICENSE_UNKNOWN', 'A referenced library license is not registered');
    }
    for (const entry of provenance) {
      if (!entry.license.active) {
        libraryFailure('LIBRARY_LICENSE_DISABLED', 'A referenced library license is disabled');
      }
      if (requireRedistribution && entry.license.redistributionAllowed !== true) {
        libraryFailure(
          'LIBRARY_LICENSE_REDISTRIBUTION_REQUIRED',
          'A public resource requires explicit redistribution permission for every license',
        );
      }
    }
    return provenance;
  }

  private async refreshProvenanceLicenses(
    provenance: readonly LibraryProvenanceRecord[],
  ): Promise<LibraryProvenanceRecord[] | null> {
    const refreshed: LibraryProvenanceRecord[] = [];
    for (const entry of provenance) {
      const license = await this.repository.findLicense(entry.licenseKey);
      if (!license) return null;
      refreshed.push({ ...entry, license });
    }
    return refreshed;
  }

  private async requireResource(resourceId: string): Promise<LibraryResourceRecord> {
    const resource = await this.repository.findResourceById(resourceId);
    if (!resource) libraryFailure('LIBRARY_RESOURCE_NOT_FOUND', 'The library resource was not found', 404);
    return resource;
  }

  private requireActor(actor: LibraryActor): void {
    if (!actor || typeof actor.userId !== 'string' || actor.userId.trim().length === 0) {
      libraryFailure('LIBRARY_ACTOR_INVALID', 'An authenticated library actor is required', 401);
    }
  }

  private requireContributionTerms(input: unknown): void {
    if (input === undefined || input === null || input === '') {
      libraryFailure('LIBRARY_CONTRIBUTION_TERMS_REQUIRED', 'The current contribution terms version is required');
    }
    if (input !== LIBRARY_CONTRIBUTION_TERMS_VERSION) {
      libraryFailure(
        'LIBRARY_CONTRIBUTION_TERMS_STALE',
        'The contribution terms version is no longer current',
        409,
      );
    }
  }

  private requireContributionConsent(input: unknown, kind: 'rights' | 'reuse'): void {
    if (input === true) return;
    if (kind === 'rights') {
      libraryFailure(
        'LIBRARY_CONTRIBUTION_RIGHTS_CONFIRMATION_REQUIRED',
        'Explicit rights confirmation is required',
      );
    }
    libraryFailure(
      'LIBRARY_CONTRIBUTION_REUSE_CONSENT_REQUIRED',
      'Explicit reuse consent is required',
    );
  }

  private requireReviewer(actor: LibraryActor): void {
    this.requireActor(actor);
    if (!actor.roles.includes('MODERATOR') && !actor.roles.includes('ADMIN')) {
      libraryFailure('LIBRARY_REVIEW_FORBIDDEN', 'An authorized reviewer is required', 403);
    }
  }

  private requireResourceEditor(actor: LibraryActor, resource: LibraryResourceRecord): void {
    if (
      resource.createdByUserId !== actor.userId &&
      !actor.roles.includes('MODERATOR') &&
      !actor.roles.includes('ADMIN')
    ) {
      libraryFailure('LIBRARY_RESOURCE_FORBIDDEN', 'You cannot modify this library resource', 403);
    }
  }

  private requireProvenanceEditor(actor: LibraryActor, resource: LibraryResourceRecord): void {
    if (resource.reviewState === 'DRAFT') {
      this.requireResourceEditor(actor, resource);
      return;
    }
    if (resource.reviewState === 'COMMUNITY_REVIEW') {
      if (resource.createdByUserId === actor.userId) {
        libraryFailure(
          'LIBRARY_REVIEW_FORBIDDEN',
          'The resource creator cannot correct provenance after submission',
          403,
        );
      }
      this.requireReviewer(actor);
      return;
    }
    libraryFailure(
      'LIBRARY_PROVENANCE_IMMUTABLE',
      'Provenance is immutable until a rejected resource is explicitly reopened',
      409,
    );
  }

  private bindSourceAuthority(
    actor: LibraryActor,
    input: NormalizedLibraryProvenanceInput,
  ): NormalizedLibraryProvenanceInput {
    const reviewer = actor.roles.includes('MODERATOR') || actor.roles.includes('ADMIN');
    if (reviewer) return input;
    if (input.sourceType !== 'ORIGINAL_AUTHOR') {
      libraryFailure(
        'LIBRARY_PROVENANCE_SOURCE_FORBIDDEN',
        'This provenance source requires an authorized reviewer or system flow',
        403,
      );
    }
    if (
      input.originalContributorUserId !== null &&
      input.originalContributorUserId !== actor.userId
    ) {
      libraryFailure(
        'LIBRARY_PROVENANCE_SOURCE_FORBIDDEN',
        'A member original-author provenance must identify the authenticated contributor',
        403,
      );
    }
    return {
      ...input,
      originalContributorUserId: actor.userId,
    };
  }

  private async requireSourceIntegrity(input: NormalizedLibraryProvenanceInput): Promise<void> {
    const hasPhase06Reference = Boolean(
      input.sourcePostId ||
      input.sourceResponseId ||
      input.sourceCandidateId ||
      input.sourceAcceptanceId,
    );
    if (input.sourceType !== 'PHASE06_LIBRARY_CANDIDATE') {
      if (hasPhase06Reference) {
        libraryFailure(
          'LIBRARY_SOURCE_REFERENCE_INVALID',
          'Phase 06 source references are only valid for Phase 06 candidate provenance',
        );
      }
      return;
    }

    if (
      !input.sourcePostId ||
      !input.sourceResponseId ||
      !input.sourceCandidateId ||
      !input.sourceAcceptanceId ||
      input.sourceId !== input.sourceCandidateId
    ) {
      libraryFailure(
        'LIBRARY_PHASE06_SOURCE_INVALID',
        'Phase 06 candidate provenance requires a complete coherent source bundle',
      );
    }

    if (this.corrections.inspectLibraryCandidateSource) {
      const health = await this.corrections.inspectLibraryCandidateSource({
        sourceId: input.sourceId,
        sourcePostId: input.sourcePostId,
        sourceResponseId: input.sourceResponseId,
        sourceCandidateId: input.sourceCandidateId,
        sourceAcceptanceId: input.sourceAcceptanceId,
      });
      if (!health.valid) {
        libraryFailure(
          'LIBRARY_PHASE06_SOURCE_INVALID',
          'The Phase 06 candidate references do not match an active pending candidate',
        );
      }
      return;
    }

    const candidate = await this.corrections.findLibraryCandidateById(input.sourceCandidateId);
    if (
      !candidate ||
      candidate.state !== 'PENDING_REVIEW' ||
      candidate.id !== input.sourceCandidateId ||
      candidate.sourcePostId !== input.sourcePostId ||
      candidate.sourceResponseId !== input.sourceResponseId ||
      candidate.acceptanceId !== input.sourceAcceptanceId
    ) {
      libraryFailure(
        'LIBRARY_PHASE06_SOURCE_INVALID',
        'The Phase 06 candidate references do not match an active pending candidate',
      );
    }
  }

  private normalize<T>(callback: () => T): T {
    try {
      return callback();
    } catch (error) {
      if (error instanceof LibraryValidationError) {
        libraryFailure(error.code, 'Library input is invalid');
      }
      throw error;
    }
  }

  private normalizeReviewNote(input: unknown, required: boolean): string | null {
    if (input === undefined || input === null || input === '') {
      if (required) libraryFailure('LIBRARY_REVIEW_NOTE_REQUIRED', 'A review note is required');
      return null;
    }
    if (typeof input !== 'string') libraryFailure('LIBRARY_REVIEW_NOTE_INVALID', 'The review note is invalid');
    const note = input.normalize('NFKC').trim();
    if (!note || Array.from(note).length > 2_000) {
      libraryFailure('LIBRARY_REVIEW_NOTE_INVALID', 'The review note is invalid');
    }
    return note;
  }

  private mapRepositoryError(error: unknown): Error {
    if (!(error instanceof LibraryRepositoryConflictError)) return error as Error;
    const status = error.code === 'LIBRARY_RESOURCE_NOT_FOUND' ? 404 : 409;
    return new LibraryFailure(error.code, status, error.message);
  }
}

function toPublicProvenance(record: LibraryProvenanceRecord): LibraryPublicProvenance {
  return {
    sourceType: record.sourceType,
    sourceId: record.sourceId,
    sourceUrl: record.sourceUrl,
    license: {
      licenseKey: record.license.licenseKey,
      displayName: record.license.displayName,
      canonicalUrl: record.license.canonicalUrl,
      attributionRequired: record.license.attributionRequired,
      redistributionAllowed: record.license.redistributionAllowed,
      derivativeConstraints: record.license.derivativeConstraints,
    },
    attribution: record.attribution,
    originalAuthorReference: record.originalAuthorReference,
  };
}

function toReviewLicenseSummary(
  license: LibraryLicenseRecord | null,
  licenseKey = '',
): LibraryReviewLicenseSummary {
  if (!license) {
    return {
      licenseKey,
      exists: false,
      displayName: null,
      canonicalUrl: null,
      attributionRequired: null,
      redistributionAllowed: null,
      derivativeConstraints: null,
      active: false,
      eligibleForPublicVerification: false,
    };
  }
  return {
    licenseKey: license.licenseKey,
    exists: true,
    displayName: license.displayName,
    canonicalUrl: license.canonicalUrl,
    attributionRequired: license.attributionRequired,
    redistributionAllowed: license.redistributionAllowed,
    derivativeConstraints: license.derivativeConstraints,
    active: license.active,
    eligibleForPublicVerification: license.active && license.redistributionAllowed === true,
  };
}

function toReviewContributionEvent(
  event: LibraryContributionEventRecord,
): LibraryReviewContributionEventSummary {
  return {
    id: event.id,
    eventType: event.eventType,
    eventVersion: event.eventVersion,
    resourceId: event.resourceId,
    reviewAuditId: event.reviewAuditId,
    resourceType: event.resourceType,
    termsVersion: event.termsVersion,
    rightsConfirmed: true,
    reuseConsent: true,
    occurredAt: new Date(event.occurredAt),
    createdAt: new Date(event.createdAt),
  };
}

function cloneDetails<T extends LibraryResourceRecord['details']>(details: T): T {
  if (details.resourceType !== 'DIALOGUE') return { ...details } as T;
  return {
    ...details,
    turns: details.turns.map((turn) => ({ ...turn })),
  } as T;
}
