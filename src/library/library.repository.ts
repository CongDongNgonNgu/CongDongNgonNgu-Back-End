import { randomUUID } from 'node:crypto';
import {
  mergeNormalizedProvenanceEntries,
  type LibraryValidationError,
} from './library.normalization';
import type {
  LibraryContributionEventRecord,
  LibraryContributionSubmissionResult,
  LibraryLicenseRecord,
  LibraryContributionResourceType,
  LibraryReviewAction,
  LibraryReviewAuditRecord,
  LibraryResourceRecord,
  LibraryReviewState,
  LibraryProvenanceRecord,
  NormalizedLibraryLicenseInput,
  NormalizedLibraryProvenanceInput,
  NormalizedLibraryResourceInput,
  LibrarySearchCursor,
  NormalizedLibraryReviewQueueFilters,
  NormalizedLibrarySearchFilters,
} from './library.types';
import { libraryResourceMatchesQuery } from './library.search';
import {
  libraryCursorMicrosFromDate,
  librarySearchCursorFromDate,
} from './library.pagination';

export const LIBRARY_REPOSITORY = 'LIBRARY_REPOSITORY';

export class LibraryRepositoryConflictError extends Error {
  constructor(
    readonly code = 'LIBRARY_REPOSITORY_CONFLICT',
    message = 'Library data conflicts with existing records',
  ) {
    super(message);
    this.name = 'LibraryRepositoryConflictError';
  }
}

export interface CreateLibraryResourceRepositoryInput extends NormalizedLibraryResourceInput {
  createdByUserId: string;
  createdAt: Date;
}

export interface TransitionLibraryReviewRepositoryInput {
  resourceId: string;
  expectedPreviousState: LibraryReviewState;
  expectedProvenanceRevision: number;
  nextState: LibraryReviewState;
  action: LibraryReviewAction;
  actorUserId: string;
  note: string | null;
  occurredAt: Date;
}

export interface SubmitLibraryContributionRepositoryInput {
  resourceId: string;
  expectedProvenanceRevision: number;
  contributorUserId: string;
  resourceType: LibraryContributionResourceType;
  termsVersion: 'library-contribution-v1';
  rightsConfirmed: true;
  reuseConsent: true;
  occurredAt: Date;
}

export interface LibraryProvenanceMutationExpectation {
  expectedReviewState: LibraryReviewState;
  expectedProvenanceRevision: number;
}

export interface LibraryReviewTransitionResult {
  resource: LibraryResourceRecord;
  audit: LibraryReviewAuditRecord;
}

export interface LibrarySearchRepositoryInput {
  filters: NormalizedLibrarySearchFilters;
  cursor?: LibrarySearchCursor;
  limit: number;
}

export interface LibrarySearchRepositoryPage {
  items: LibraryResourceRecord[];
  hasMore: boolean;
  nextBoundary: LibrarySearchCursor | null;
}

export interface LibraryReviewQueueRepositoryInput {
  filters: NormalizedLibraryReviewQueueFilters;
  cursor?: LibrarySearchCursor;
  limit: number;
}

export interface LibraryReviewQueueRepositoryPage {
  items: LibraryResourceRecord[];
  hasMore: boolean;
  nextBoundary: LibrarySearchCursor | null;
  /** Exact ordered-row boundaries aligned with items when a scan needs them. */
  itemBoundaries?: LibrarySearchCursor[];
}

export interface LibraryInvalidSourceQueueRepositoryInput {
  cursor?: LibrarySearchCursor;
  limit: number;
}

export interface ReconcileLibrarySourceRepositoryInput {
  resourceId: string;
  expectedPreviousState: 'VERIFIED';
  expectedProvenanceRevision: number;
  actorUserId: string;
  note: string | null;
  occurredAt: Date;
}

export interface LibraryRepository {
  upsertLicense(
    input: NormalizedLibraryLicenseInput,
    now?: Date,
  ): Promise<LibraryLicenseRecord>;
  findLicense(licenseKey: string): Promise<LibraryLicenseRecord | null>;
  listLicenses(): Promise<LibraryLicenseRecord[]>;
  createResource(input: CreateLibraryResourceRepositoryInput): Promise<LibraryResourceRecord>;
  findResourceById(id: string): Promise<LibraryResourceRecord | null>;
  searchPublicResources(input: LibrarySearchRepositoryInput): Promise<LibrarySearchRepositoryPage>;
  listReviewQueue(input: LibraryReviewQueueRepositoryInput): Promise<LibraryReviewQueueRepositoryPage>;
  // The service scans this deterministic Phase 06-backed superset and applies
  // current source health before exposing the logical invalid-source page.
  listInvalidSourceQueue(
    input: LibraryInvalidSourceQueueRepositoryInput,
  ): Promise<LibraryReviewQueueRepositoryPage>;
  addProvenance(
    resourceId: string,
    input: NormalizedLibraryProvenanceInput,
    expectation: LibraryProvenanceMutationExpectation,
    now?: Date,
  ): Promise<LibraryProvenanceRecord>;
  mergeProvenance(
    resourceId: string,
    inputs: readonly NormalizedLibraryProvenanceInput[],
    expectation: LibraryProvenanceMutationExpectation,
    now?: Date,
  ): Promise<LibraryProvenanceRecord[]>;
  transitionReview(
    input: TransitionLibraryReviewRepositoryInput,
  ): Promise<LibraryReviewTransitionResult>;
  reconcileSource(
    input: ReconcileLibrarySourceRepositoryInput,
  ): Promise<LibraryReviewTransitionResult>;
  submitContribution(
    input: SubmitLibraryContributionRepositoryInput,
  ): Promise<LibraryContributionSubmissionResult>;
  listReviewAudit(resourceId: string): Promise<LibraryReviewAuditRecord[]>;
  listContributionEvents(resourceId?: string): Promise<LibraryContributionEventRecord[]>;
}

export class InMemoryLibraryRepository implements LibraryRepository {
  private readonly licenses = new Map<string, LibraryLicenseRecord>();
  private readonly resources = new Map<string, LibraryResourceRecord>();
  private readonly reviewAudits = new Map<string, LibraryReviewAuditRecord[]>();
  private readonly contributionEvents = new Map<string, LibraryContributionEventRecord>();

  async upsertLicense(
    input: NormalizedLibraryLicenseInput,
    now = new Date(),
  ): Promise<LibraryLicenseRecord> {
    const existing = this.licenses.get(input.licenseKey);
    const record: LibraryLicenseRecord = {
      ...input,
      createdAt: existing ? new Date(existing.createdAt) : new Date(now),
      updatedAt: new Date(now),
    };
    this.licenses.set(record.licenseKey, record);
    return cloneLicense(record);
  }

  async findLicense(licenseKey: string): Promise<LibraryLicenseRecord | null> {
    const record = this.licenses.get(licenseKey);
    return record ? cloneLicense(record) : null;
  }

  async listLicenses(): Promise<LibraryLicenseRecord[]> {
    return [...this.licenses.values()]
      .sort((left, right) => left.licenseKey.localeCompare(right.licenseKey))
      .map(cloneLicense);
  }

  async createResource(input: CreateLibraryResourceRepositoryInput): Promise<LibraryResourceRecord> {
    const record: LibraryResourceRecord = {
      id: randomUUID(),
      resourceType: input.resourceType,
      primaryLanguageCode: input.primaryLanguageCode,
      secondaryLanguageCode: input.secondaryLanguageCode,
      cefrLevel: input.cefrLevel,
      topics: [...input.topics],
      createdByUserId: input.createdByUserId,
      visibility: input.visibility,
      moderationState: 'ACTIVE',
      reviewState: 'DRAFT',
      createdAt: new Date(input.createdAt),
      updatedAt: new Date(input.createdAt),
      reviewedByUserId: null,
      reviewedAt: null,
      provenanceRevision: 0,
      details: cloneDetails(input.details),
      provenance: [],
    };
    this.resources.set(record.id, record);
    return cloneResource(record);
  }

  async findResourceById(id: string): Promise<LibraryResourceRecord | null> {
    const record = this.resources.get(id);
    return record ? cloneResource(record) : null;
  }

  async searchPublicResources(
    input: LibrarySearchRepositoryInput,
  ): Promise<LibrarySearchRepositoryPage> {
    const eligible = [...this.resources.values()]
      .filter((resource) => (
        resource.visibility === 'PUBLIC' &&
        resource.moderationState === 'ACTIVE' &&
        resource.reviewState === 'VERIFIED' &&
        resource.provenance.length > 0 &&
        resource.provenance.every((entry) => {
          const license = this.licenses.get(entry.licenseKey);
          return Boolean(license?.active && license.redistributionAllowed === true);
        })
      ))
      .filter((resource) => !input.filters.languageCode || (
        resource.primaryLanguageCode === input.filters.languageCode ||
        resource.secondaryLanguageCode === input.filters.languageCode
      ))
      .filter((resource) => !input.filters.resourceType || resource.resourceType === input.filters.resourceType)
      .filter((resource) => !input.filters.topic || resource.topics.includes(input.filters.topic))
      .filter((resource) => !input.filters.cefrLevel || resource.cefrLevel === input.filters.cefrLevel)
      .filter((resource) => libraryResourceMatchesQuery(resource, input.filters.q))
      .sort(compareSearchResources)
      .filter((resource) => {
        if (!input.cursor) return true;
        const timestamp = BigInt(libraryCursorMicrosFromDate(resource.updatedAt));
        const cursorTimestamp = BigInt(input.cursor.updatedAtMicros);
        return timestamp < cursorTimestamp || (
          timestamp === cursorTimestamp && resource.id < input.cursor.id
        );
      });
    const selectedRows = eligible.slice(0, input.limit + 1);
    const consumedRows = selectedRows.slice(0, input.limit);
    const hasMore = selectedRows.length > input.limit;
    return {
      items: consumedRows.map(cloneResource),
      hasMore,
      nextBoundary: hasMore && consumedRows.at(-1)
        ? librarySearchCursorFromDate(
          consumedRows.at(-1)!.updatedAt,
          consumedRows.at(-1)!.id,
        )
        : null,
    };
  }

  async listInvalidSourceQueue(
    input: LibraryInvalidSourceQueueRepositoryInput,
  ): Promise<LibraryReviewQueueRepositoryPage> {
    const candidates = [...this.resources.values()]
      .filter((resource) => (
        resource.reviewState === 'VERIFIED' &&
        resource.provenance.some((entry) => entry.sourceType === 'PHASE06_LIBRARY_CANDIDATE')
      ))
      .filter((resource) => isAfterReviewCursor(resource, input.cursor))
      .sort(compareReviewQueueResources);
    const rows = candidates.slice(0, input.limit + 1);
    const items = rows.slice(0, input.limit).map(cloneResource);
    const hasMore = rows.length > input.limit;
    const last = items.at(-1);
    return {
      items,
      hasMore,
      nextBoundary: hasMore && last
        ? librarySearchCursorFromDate(last.updatedAt, last.id)
        : null,
      itemBoundaries: items.map((resource) => librarySearchCursorFromDate(resource.updatedAt, resource.id)),
    };
  }

  async listReviewQueue(
    input: LibraryReviewQueueRepositoryInput,
  ): Promise<LibraryReviewQueueRepositoryPage> {
    const eligible = [...this.resources.values()]
      .filter((resource) => resource.reviewState === 'COMMUNITY_REVIEW')
      .filter((resource) => !input.filters.languageCode || (
        resource.primaryLanguageCode === input.filters.languageCode ||
        resource.secondaryLanguageCode === input.filters.languageCode
      ))
      .filter((resource) => !input.filters.resourceType || resource.resourceType === input.filters.resourceType)
      .filter((resource) => libraryResourceMatchesQuery(resource, input.filters.q))
      .sort(compareReviewQueueResources)
      .filter((resource) => {
        if (!input.cursor) return true;
        const timestamp = BigInt(libraryCursorMicrosFromDate(resource.updatedAt));
        const cursorTimestamp = BigInt(input.cursor.updatedAtMicros);
        return timestamp > cursorTimestamp || (
          timestamp === cursorTimestamp && resource.id > input.cursor.id
        );
      });
    const selectedRows = eligible.slice(0, input.limit + 1);
    const consumedRows = selectedRows.slice(0, input.limit);
    const hasMore = selectedRows.length > input.limit;
    return {
      items: consumedRows.map(cloneResource),
      hasMore,
      nextBoundary: hasMore && consumedRows.at(-1)
        ? librarySearchCursorFromDate(
          consumedRows.at(-1)!.updatedAt,
          consumedRows.at(-1)!.id,
        )
        : null,
    };
  }

  async addProvenance(
    resourceId: string,
    input: NormalizedLibraryProvenanceInput,
    expectation: LibraryProvenanceMutationExpectation,
    now = new Date(),
  ): Promise<LibraryProvenanceRecord> {
    const resource = this.requireResource(resourceId);
    this.requireProvenanceMutationState(resource, expectation);
    this.requireActiveLicense(input.licenseKey);
    if (resource.provenance.some((entry) => provenanceKey(entry) === provenanceKey(input))) {
      throw new LibraryRepositoryConflictError(
        'LIBRARY_PROVENANCE_DUPLICATE',
        'A provenance source is already attached to this resource',
      );
    }
    const license = this.licenses.get(input.licenseKey)!;
    const record = createProvenance(resourceId, input, license, now);
    resource.provenance.push(record);
    resource.provenanceRevision += 1;
    resource.updatedAt = new Date(now);
    return cloneProvenance(record);
  }

  async mergeProvenance(
    resourceId: string,
    inputs: readonly NormalizedLibraryProvenanceInput[],
    expectation: LibraryProvenanceMutationExpectation,
    now = new Date(),
  ): Promise<LibraryProvenanceRecord[]> {
    const resource = this.requireResource(resourceId);
    this.requireProvenanceMutationState(resource, expectation);
    const existingInputs = resource.provenance.map(toNormalizedProvenance);
    let merged: NormalizedLibraryProvenanceInput[];
    try {
      merged = mergeNormalizedProvenanceEntries(existingInputs, inputs);
    } catch (error) {
      if (isValidationError(error) && error.code === 'LIBRARY_PROVENANCE_DUPLICATE') {
        throw new LibraryRepositoryConflictError(
          error.code,
          'A provenance source conflicts with existing attribution',
        );
      }
      throw error;
    }
    const existingKeys = new Set(resource.provenance.map(provenanceKey));
    for (const entry of merged) {
      if (existingKeys.has(provenanceKey(entry))) continue;
      this.requireActiveLicense(entry.licenseKey);
      const license = this.licenses.get(entry.licenseKey)!;
      resource.provenance.push(createProvenance(resourceId, entry, license, now));
      resource.provenanceRevision += 1;
    }
    resource.updatedAt = new Date(now);
    return resource.provenance.map(cloneProvenance);
  }

  async transitionReview(
    input: TransitionLibraryReviewRepositoryInput,
  ): Promise<LibraryReviewTransitionResult> {
    const resource = this.requireResource(input.resourceId);
    if (
      resource.reviewState !== input.expectedPreviousState ||
      resource.provenanceRevision !== input.expectedProvenanceRevision
    ) {
      throw new LibraryRepositoryConflictError(
        'LIBRARY_REVIEW_CONFLICT',
        'The resource review state or provenance changed before this transition',
      );
    }
    const previousState = resource.reviewState;
    resource.reviewState = input.nextState;
    resource.updatedAt = new Date(input.occurredAt);
    if (input.nextState === 'VERIFIED' || input.nextState === 'REJECTED') {
      resource.reviewedByUserId = input.actorUserId;
      resource.reviewedAt = new Date(input.occurredAt);
    } else {
      resource.reviewedByUserId = null;
      resource.reviewedAt = null;
    }
    const audit: LibraryReviewAuditRecord = {
      id: randomUUID(),
      resourceId: resource.id,
      actorUserId: input.actorUserId,
      previousState,
      newState: input.nextState,
      action: input.action,
      note: input.note,
      createdAt: new Date(input.occurredAt),
    };
    const history = this.reviewAudits.get(resource.id) ?? [];
    history.push(audit);
    this.reviewAudits.set(resource.id, history);
    return {
      resource: cloneResource(resource),
      audit: cloneAudit(audit),
    };
  }

  async reconcileSource(
    input: ReconcileLibrarySourceRepositoryInput,
  ): Promise<LibraryReviewTransitionResult> {
    const resource = this.requireResource(input.resourceId);
    if (
      resource.reviewState !== input.expectedPreviousState ||
      resource.provenanceRevision !== input.expectedProvenanceRevision
    ) {
      throw new LibraryRepositoryConflictError(
        'LIBRARY_REVIEW_CONFLICT',
        'The resource review state or provenance changed before source reconciliation',
      );
    }
    resource.reviewState = 'COMMUNITY_REVIEW';
    resource.reviewedByUserId = null;
    resource.reviewedAt = null;
    resource.updatedAt = new Date(input.occurredAt);
    const audit: LibraryReviewAuditRecord = {
      id: randomUUID(),
      resourceId: resource.id,
      actorUserId: input.actorUserId,
      previousState: 'VERIFIED',
      newState: 'COMMUNITY_REVIEW',
      action: 'INVALIDATE',
      note: input.note,
      createdAt: new Date(input.occurredAt),
    };
    const history = this.reviewAudits.get(resource.id) ?? [];
    history.push(audit);
    this.reviewAudits.set(resource.id, history);
    return { resource: cloneResource(resource), audit: cloneAudit(audit) };
  }

  async submitContribution(
    input: SubmitLibraryContributionRepositoryInput,
  ): Promise<LibraryContributionSubmissionResult> {
    const resource = this.requireResource(input.resourceId);
    if (
      resource.reviewState !== 'DRAFT' ||
      resource.provenanceRevision !== input.expectedProvenanceRevision
    ) {
      throw new LibraryRepositoryConflictError(
        'LIBRARY_CONTRIBUTION_CONFLICT',
        'The library contribution is no longer an editable draft',
      );
    }

    const previousResource = cloneResource(resource);
    const previousHistory = this.reviewAudits.get(resource.id);
    const previousHistoryLength = previousHistory?.length ?? 0;
    const previousEventIds = new Set(this.contributionEvents.keys());
    const audit: LibraryReviewAuditRecord = {
      id: randomUUID(),
      resourceId: resource.id,
      actorUserId: input.contributorUserId,
      previousState: 'DRAFT',
      newState: 'COMMUNITY_REVIEW',
      action: 'SUBMIT',
      note: null,
      createdAt: new Date(input.occurredAt),
    };
    const event: LibraryContributionEventRecord = {
      id: randomUUID(),
      eventType: 'LIBRARY_CONTRIBUTION_SUBMITTED',
      eventVersion: 1,
      resourceId: resource.id,
      contributorUserId: input.contributorUserId,
      reviewAuditId: audit.id,
      resourceType: input.resourceType,
      termsVersion: 'library-contribution-v1',
      rightsConfirmed: true,
      reuseConsent: true,
      occurredAt: new Date(input.occurredAt),
      createdAt: new Date(input.occurredAt),
    };

    try {
      resource.reviewState = 'COMMUNITY_REVIEW';
      resource.updatedAt = new Date(input.occurredAt);
      resource.reviewedByUserId = null;
      resource.reviewedAt = null;
      const history = this.reviewAudits.get(resource.id) ?? [];
      history.push(audit);
      this.reviewAudits.set(resource.id, history);
      this.insertContributionEvent(event);
      return {
        resource: cloneResource(resource),
        audit: cloneAudit(audit),
        event: cloneContributionEvent(event),
      };
    } catch (error) {
      Object.assign(resource, previousResource);
      if (previousHistory) {
        previousHistory.splice(previousHistoryLength);
        this.reviewAudits.set(resource.id, previousHistory);
      } else {
        this.reviewAudits.delete(resource.id);
      }
      for (const eventId of [...this.contributionEvents.keys()]) {
        if (!previousEventIds.has(eventId)) this.contributionEvents.delete(eventId);
      }
      throw error;
    }
  }

  async listReviewAudit(resourceId: string): Promise<LibraryReviewAuditRecord[]> {
    return (this.reviewAudits.get(resourceId) ?? []).map(cloneAudit);
  }

  async listContributionEvents(resourceId?: string): Promise<LibraryContributionEventRecord[]> {
    return [...this.contributionEvents.values()]
      .filter((event) => !resourceId || event.resourceId === resourceId)
      .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime() || left.id.localeCompare(right.id))
      .map(cloneContributionEvent);
  }

  protected insertContributionEvent(event: LibraryContributionEventRecord): void {
    if ([...this.contributionEvents.values()].some((existing) => existing.reviewAuditId === event.reviewAuditId)) {
      throw new LibraryRepositoryConflictError(
        'LIBRARY_CONTRIBUTION_DUPLICATE',
        'A contribution event already exists for this review submission',
      );
    }
    this.contributionEvents.set(event.id, cloneContributionEvent(event));
  }

  private requireResource(id: string): LibraryResourceRecord {
    const resource = this.resources.get(id);
    if (!resource) {
      throw new LibraryRepositoryConflictError(
        'LIBRARY_RESOURCE_NOT_FOUND',
        'Library resource was not found',
      );
    }
    return resource;
  }

  private requireActiveLicense(licenseKey: string): void {
    const license = this.licenses.get(licenseKey);
    if (!license) {
      throw new LibraryRepositoryConflictError(
        'LIBRARY_LICENSE_UNKNOWN',
        'Library license was not found',
      );
    }
    if (!license.active) {
      throw new LibraryRepositoryConflictError(
        'LIBRARY_LICENSE_DISABLED',
        'Library license is disabled',
      );
    }
  }

  private requireProvenanceMutationState(
    resource: LibraryResourceRecord,
    expectation: LibraryProvenanceMutationExpectation,
  ): void {
    if (resource.reviewState !== 'DRAFT' && resource.reviewState !== 'COMMUNITY_REVIEW') {
      throw new LibraryRepositoryConflictError(
        'LIBRARY_PROVENANCE_IMMUTABLE',
        'Provenance cannot be changed in the current review state',
      );
    }
    if (
      resource.reviewState !== expectation.expectedReviewState ||
      resource.provenanceRevision !== expectation.expectedProvenanceRevision
    ) {
      throw new LibraryRepositoryConflictError(
        'LIBRARY_REVIEW_CONFLICT',
        'The resource review state or provenance changed before this mutation',
      );
    }
  }
}

function compareSearchResources(a: LibraryResourceRecord, b: LibraryResourceRecord): number {
  const timestampDifference = b.updatedAt.getTime() - a.updatedAt.getTime();
  if (timestampDifference !== 0) return timestampDifference;
  return b.id > a.id ? 1 : b.id < a.id ? -1 : 0;
}

function compareReviewQueueResources(a: LibraryResourceRecord, b: LibraryResourceRecord): number {
  const timestampDifference = a.updatedAt.getTime() - b.updatedAt.getTime();
  if (timestampDifference !== 0) return timestampDifference;
  return a.id > b.id ? 1 : a.id < b.id ? -1 : 0;
}

function isAfterReviewCursor(
  resource: LibraryResourceRecord,
  cursor: LibrarySearchCursor | undefined,
): boolean {
  if (!cursor) return true;
  const resourceTimestamp = BigInt(libraryCursorMicrosFromDate(resource.updatedAt));
  const cursorTimestamp = BigInt(cursor.updatedAtMicros);
  return (
    resourceTimestamp > cursorTimestamp ||
    (resourceTimestamp === cursorTimestamp && resource.id > cursor.id)
  );
}

function createProvenance(
  resourceId: string,
  input: NormalizedLibraryProvenanceInput,
  license: LibraryLicenseRecord,
  now: Date,
): LibraryProvenanceRecord {
  return {
    ...cloneNormalizedProvenance(input),
    id: randomUUID(),
    resourceId,
    createdAt: new Date(now),
    updatedAt: new Date(now),
    license: cloneLicense(license),
  };
}

function toNormalizedProvenance(record: LibraryProvenanceRecord): NormalizedLibraryProvenanceInput {
  return {
    sourceType: record.sourceType,
    sourceId: record.sourceId,
    sourceUrl: record.sourceUrl,
    licenseKey: record.licenseKey,
    attribution: record.attribution,
    originalAuthorReference: record.originalAuthorReference,
    originalContributorUserId: record.originalContributorUserId,
    importBatch: record.importBatch,
    transformationHistory: record.transformationHistory,
    sourcePostId: record.sourcePostId,
    sourceResponseId: record.sourceResponseId,
    sourceCandidateId: record.sourceCandidateId,
    sourceAcceptanceId: record.sourceAcceptanceId,
  };
}

function provenanceKey(
  entry: Pick<NormalizedLibraryProvenanceInput, 'sourceType' | 'sourceId'>,
): string {
  return entry.sourceType + ':' + entry.sourceId;
}

function cloneLicense(record: LibraryLicenseRecord): LibraryLicenseRecord {
  return {
    ...record,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

function cloneProvenance(record: LibraryProvenanceRecord): LibraryProvenanceRecord {
  return {
    ...cloneNormalizedProvenance(record),
    id: record.id,
    resourceId: record.resourceId,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    license: cloneLicense(record.license),
  };
}

function cloneNormalizedProvenance(
  record: NormalizedLibraryProvenanceInput | LibraryProvenanceRecord,
): NormalizedLibraryProvenanceInput {
  return {
    sourceType: record.sourceType,
    sourceId: record.sourceId,
    sourceUrl: record.sourceUrl,
    licenseKey: record.licenseKey,
    attribution: record.attribution,
    originalAuthorReference: record.originalAuthorReference,
    originalContributorUserId: record.originalContributorUserId,
    importBatch: record.importBatch,
    transformationHistory: record.transformationHistory.map((entry) => ({
      ...entry,
      metadata: entry.metadata ? { ...entry.metadata } : null,
    })),
    sourcePostId: record.sourcePostId,
    sourceResponseId: record.sourceResponseId,
    sourceCandidateId: record.sourceCandidateId,
    sourceAcceptanceId: record.sourceAcceptanceId,
  };
}

function cloneResource(record: LibraryResourceRecord): LibraryResourceRecord {
  return {
    ...record,
    topics: [...record.topics],
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    reviewedAt: record.reviewedAt ? new Date(record.reviewedAt) : null,
    details: cloneDetails(record.details),
    provenance: record.provenance.map(cloneProvenance),
  };
}

function cloneDetails<T extends LibraryResourceRecord['details']>(details: T): T {
  if (details.resourceType !== 'DIALOGUE') return { ...details } as T;
  return {
    ...details,
    turns: details.turns.map((turn) => ({ ...turn })),
  } as T;
}

function cloneAudit(record: LibraryReviewAuditRecord): LibraryReviewAuditRecord {
  return { ...record, createdAt: new Date(record.createdAt) };
}

function cloneContributionEvent(record: LibraryContributionEventRecord): LibraryContributionEventRecord {
  return {
    ...record,
    occurredAt: new Date(record.occurredAt),
    createdAt: new Date(record.createdAt),
  };
}

function isValidationError(error: unknown): error is LibraryValidationError {
  return error instanceof Error && error.name === 'LibraryValidationError' && 'code' in error;
}
