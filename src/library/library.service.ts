import { Inject, Injectable } from '@nestjs/common';
import { CORRECTIONS_REPOSITORY } from '../corrections/corrections.repository';
import type { CorrectionsRepository } from '../corrections/corrections.repository';
import { PROFILE_REPOSITORY } from '../profile/profile.repository';
import type { ProfileRepository } from '../profile/profile.repository';
import {
  assertLibraryReviewTransition,
  LibraryValidationError,
  normalizeLibraryLicenseInput,
  normalizeLibraryProvenanceInput,
  normalizeLibraryResourceInput,
  normalizeReviewState,
} from './library.normalization';
import { LibraryFailure, libraryFailure } from './library.errors';
import {
  LIBRARY_REPOSITORY,
  LibraryRepositoryConflictError,
  type LibraryRepository,
} from './library.repository';
import type {
  CreateLibraryResourceInput,
  LibraryActor,
  LibraryLicenseInput,
  LibraryLicenseRecord,
  LibraryPublicResource,
  LibraryPublicProvenance,
  LibraryProvenanceInput,
  LibraryProvenanceRecord,
  LibraryResourceRecord,
  LibraryReviewAuditRecord,
  NormalizedLibraryLicenseInput,
  NormalizedLibraryProvenanceInput,
} from './library.types';

@Injectable()
export class LibraryService {
  constructor(
    @Inject(LIBRARY_REPOSITORY) private readonly repository: LibraryRepository,
    @Inject(PROFILE_REPOSITORY) private readonly profiles: ProfileRepository,
    @Inject(CORRECTIONS_REPOSITORY)
    private readonly corrections: Pick<CorrectionsRepository, 'findLibraryCandidateById'>,
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
    const normalized = this.normalize(() => normalizeLibraryProvenanceInput(input));
    this.requireSourceAuthority(actor, normalized);
    await this.requireSourceIntegrity(normalized);
    await this.requireActiveLicense(normalized.licenseKey);

    try {
      return await this.repository.addProvenance(resourceId, normalized, new Date());
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
    const normalized = inputs.map((input) => this.normalize(() => normalizeLibraryProvenanceInput(input)));
    for (const entry of normalized) {
      this.requireSourceAuthority(actor, entry);
      await this.requireSourceIntegrity(entry);
    }
    for (const entry of normalized) await this.requireActiveLicense(entry.licenseKey);

    try {
      return await this.repository.mergeProvenance(resourceId, normalized, new Date());
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
    const action = this.normalize(() => assertLibraryReviewTransition(resource.reviewState, nextState));

    if (action === 'SUBMIT') {
      if (resource.createdByUserId !== actor.userId) {
        libraryFailure('LIBRARY_SUBMIT_FORBIDDEN', 'Only the resource creator can submit a draft for review', 403);
      }
    } else {
      this.requireReviewer(actor);
      if (action === 'VERIFY' && resource.createdByUserId === actor.userId) {
        libraryFailure('LIBRARY_SELF_VERIFICATION_DENIED', 'A submitter cannot verify their own resource', 403);
      }
      if (action === 'VERIFY') {
        if (resource.provenance.length === 0) {
          libraryFailure('LIBRARY_PROVENANCE_REQUIRED', 'A resource needs provenance before verification');
        }
        await this.requireCurrentProvenanceLicenses(resource, resource.visibility === 'PUBLIC');
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
      this.requireReviewer(actor);
      return;
    }
    libraryFailure(
      'LIBRARY_PROVENANCE_IMMUTABLE',
      'Provenance is immutable until a rejected resource is explicitly reopened',
      409,
    );
  }

  private requireSourceAuthority(
    actor: LibraryActor,
    input: NormalizedLibraryProvenanceInput,
  ): void {
    const reviewer = actor.roles.includes('MODERATOR') || actor.roles.includes('ADMIN');
    if (reviewer) return;
    if (
      input.sourceType !== 'ORIGINAL_AUTHOR' ||
      (input.originalContributorUserId !== null && input.originalContributorUserId !== actor.userId)
    ) {
      libraryFailure(
        'LIBRARY_PROVENANCE_SOURCE_FORBIDDEN',
        'This provenance source requires an authorized reviewer or system flow',
        403,
      );
    }
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

function cloneDetails<T extends LibraryResourceRecord['details']>(details: T): T {
  if (details.resourceType !== 'DIALOGUE') return { ...details } as T;
  return {
    ...details,
    turns: details.turns.map((turn) => ({ ...turn })),
  } as T;
}
