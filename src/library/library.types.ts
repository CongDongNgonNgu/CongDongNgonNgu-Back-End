import type {
  CommunityCefrLevel,
  CommunityModerationState,
  CommunityVisibility,
} from '../community/community.types';
import type { RoleKey } from '../identity/identity.types';
import type { Phase06SourceHealthReason } from '../corrections/corrections.source-health';

export const LIBRARY_RESOURCE_TYPES = [
  'VOCABULARY',
  'SENTENCE',
  'TRANSLATION',
  'GRAMMAR_ITEM',
  'DIALOGUE',
  'IDIOM',
  'SLANG',
  'CULTURAL_NOTE',
  'PRONUNCIATION',
  'LEARNING_COLLECTION',
] as const;

export type LibraryResourceType = typeof LIBRARY_RESOURCE_TYPES[number];

export const LIBRARY_CONTRIBUTION_RESOURCE_TYPES = [
  'VOCABULARY',
  'SENTENCE',
  'TRANSLATION',
] as const satisfies readonly LibraryResourceType[];

export type LibraryContributionResourceType = typeof LIBRARY_CONTRIBUTION_RESOURCE_TYPES[number];
export const LIBRARY_CONTRIBUTION_TERMS_VERSION = 'library-contribution-v1' as const;
export const LIBRARY_CONTRIBUTION_EVENT_TYPE = 'LIBRARY_CONTRIBUTION_SUBMITTED' as const;
export const LIBRARY_CONTRIBUTION_EVENT_VERSION = 1 as const;

export const LIBRARY_SEARCH_DEFAULT_LIMIT = 20;
export const LIBRARY_SEARCH_MAX_LIMIT = 50;
export const LIBRARY_SEARCH_MAX_QUERY_LENGTH = 120;

export interface LibrarySearchInput {
  q?: unknown;
  language?: unknown;
  type?: unknown;
  topic?: unknown;
  level?: unknown;
  cursor?: unknown;
  limit?: unknown;
}

export interface LibraryReviewQueueInput {
  q?: unknown;
  language?: unknown;
  type?: unknown;
  cursor?: unknown;
  limit?: unknown;
}

export interface LibraryInvalidSourceQueueInput {
  cursor?: unknown;
  limit?: unknown;
}

export interface NormalizedLibrarySearchFilters {
  q: string | null;
  languageCode: string | null;
  resourceType: LibraryResourceType | null;
  topic: string | null;
  cefrLevel: CommunityCefrLevel | null;
}

export interface NormalizedLibrarySearchInput {
  filters: NormalizedLibrarySearchFilters;
  cursor: string | undefined;
  limit: number;
}

export interface NormalizedLibraryReviewQueueFilters {
  q: string | null;
  languageCode: string | null;
  resourceType: LibraryResourceType | null;
}

export interface NormalizedLibraryReviewQueueInput {
  filters: NormalizedLibraryReviewQueueFilters;
  cursor: string | undefined;
  limit: number;
}

export interface NormalizedLibraryInvalidSourceQueueInput {
  cursor: string | undefined;
  limit: number;
}

export interface LibrarySearchCursor {
  /** Exact PostgreSQL timestamptz boundary in epoch microseconds. */
  updatedAtMicros: string;
  id: string;
}

export const LIBRARY_REVIEW_STATES = [
  'DRAFT',
  'COMMUNITY_REVIEW',
  'VERIFIED',
  'REJECTED',
] as const;

export type LibraryReviewState = typeof LIBRARY_REVIEW_STATES[number];

export const LIBRARY_SOURCE_TYPES = [
  'COMMUNITY_POST',
  'PHASE06_LIBRARY_CANDIDATE',
  'OPEN_DATASET',
  'MANUAL_ENTRY',
  'ORIGINAL_AUTHOR',
] as const;

export type LibrarySourceType = typeof LIBRARY_SOURCE_TYPES[number];

export const LIBRARY_REVIEW_ACTIONS = [
  'SUBMIT',
  'VERIFY',
  'REJECT',
  'INVALIDATE',
  'REOPEN',
] as const;

export type LibraryReviewAction = typeof LIBRARY_REVIEW_ACTIONS[number];

export type LibraryRedistributionAllowed = boolean | null;

export interface LibraryActor {
  userId: string;
  roles: readonly RoleKey[];
}

export interface LibraryLicenseInput {
  licenseKey: unknown;
  displayName: unknown;
  canonicalUrl: unknown;
  attributionRequired: unknown;
  redistributionAllowed: unknown;
  derivativeConstraints?: unknown;
  active?: unknown;
  sourceNote?: unknown;
}

export interface NormalizedLibraryLicenseInput {
  licenseKey: string;
  displayName: string;
  canonicalUrl: string;
  attributionRequired: boolean;
  redistributionAllowed: LibraryRedistributionAllowed;
  derivativeConstraints: string | null;
  active: boolean;
  sourceNote: string | null;
}

export interface LibraryLicenseRecord extends NormalizedLibraryLicenseInput {
  createdAt: Date;
  updatedAt: Date;
}

export interface LibraryContributionPolicyLicense {
  licenseKey: string;
  displayName: string;
  canonicalUrl: string;
  attributionRequired: boolean;
  redistributionAllowed: true;
  derivativeConstraints: string | null;
}

export interface LibraryContributionPolicy {
  termsVersion: typeof LIBRARY_CONTRIBUTION_TERMS_VERSION;
  approvedResourceTypes: readonly LibraryContributionResourceType[];
  licenses: LibraryContributionPolicyLicense[];
}

export interface LibraryTransformationInput {
  operation: unknown;
  metadata?: unknown;
  occurredAt?: unknown;
}

export interface LibraryTransformationRecord {
  operation: string;
  metadata: Record<string, string | number | boolean> | null;
  occurredAt: string;
}

export interface LibraryProvenanceInput {
  sourceType: unknown;
  sourceId: unknown;
  sourceUrl?: unknown;
  licenseKey: unknown;
  attribution: unknown;
  originalAuthorReference?: unknown;
  originalContributorUserId?: unknown;
  importBatch?: unknown;
  transformationHistory?: unknown;
  sourcePostId?: unknown;
  sourceResponseId?: unknown;
  sourceCandidateId?: unknown;
  sourceAcceptanceId?: unknown;
}

export interface NormalizedLibraryProvenanceInput {
  sourceType: LibrarySourceType;
  sourceId: string;
  sourceUrl: string | null;
  licenseKey: string;
  attribution: string;
  originalAuthorReference: string | null;
  originalContributorUserId: string | null;
  importBatch: string | null;
  transformationHistory: LibraryTransformationRecord[];
  sourcePostId: string | null;
  sourceResponseId: string | null;
  sourceCandidateId: string | null;
  sourceAcceptanceId: string | null;
}

export interface LibraryProvenanceRecord extends NormalizedLibraryProvenanceInput {
  id: string;
  resourceId: string;
  createdAt: Date;
  updatedAt: Date;
  license: LibraryLicenseRecord;
}

export interface LibraryPublicLicense {
  licenseKey: string;
  displayName: string;
  canonicalUrl: string;
  attributionRequired: boolean;
  redistributionAllowed: LibraryRedistributionAllowed;
  derivativeConstraints: string | null;
}

export interface LibraryPublicProvenance {
  sourceType: LibrarySourceType;
  sourceId: string;
  sourceUrl: string | null;
  license: LibraryPublicLicense;
  attribution: string;
  originalAuthorReference: string | null;
}

export interface VocabularyDetails {
  term: string;
  definition: string;
  partOfSpeech: string | null;
  exampleSentence: string | null;
}

export interface SentenceDetails {
  text: string;
  context: string | null;
}

export interface TranslationDetails {
  sourceText: string;
  translatedText: string;
}

export interface GrammarItemDetails {
  title: string;
  explanation: string;
  pattern: string | null;
  exampleText: string | null;
}

export interface DialogueTurn {
  speaker: string;
  text: string;
  translation: string | null;
}

export interface DialogueDetails {
  title: string;
  turns: DialogueTurn[];
}

export interface IdiomDetails {
  expression: string;
  meaning: string;
  usageNote: string | null;
}

export interface SlangDetails {
  expression: string;
  meaning: string;
  register: string | null;
  usageNote: string | null;
}

export interface CulturalNoteDetails {
  title: string;
  body: string;
}

export interface PronunciationDetails {
  term: string;
  phonetic: string;
  notes: string | null;
}

export interface LearningCollectionDetails {
  title: string;
  description: string;
}

export type LibraryResourceDetails =
  | ({ resourceType: 'VOCABULARY' } & VocabularyDetails)
  | ({ resourceType: 'SENTENCE' } & SentenceDetails)
  | ({ resourceType: 'TRANSLATION' } & TranslationDetails)
  | ({ resourceType: 'GRAMMAR_ITEM' } & GrammarItemDetails)
  | ({ resourceType: 'DIALOGUE' } & DialogueDetails)
  | ({ resourceType: 'IDIOM' } & IdiomDetails)
  | ({ resourceType: 'SLANG' } & SlangDetails)
  | ({ resourceType: 'CULTURAL_NOTE' } & CulturalNoteDetails)
  | ({ resourceType: 'PRONUNCIATION' } & PronunciationDetails)
  | ({ resourceType: 'LEARNING_COLLECTION' } & LearningCollectionDetails);

export interface CreateLibraryResourceInput {
  resourceType: unknown;
  primaryLanguageCode: unknown;
  secondaryLanguageCode?: unknown;
  cefrLevel?: unknown;
  topics?: unknown;
  visibility?: unknown;
  details: unknown;
}

export interface NormalizedLibraryResourceInput {
  resourceType: LibraryResourceType;
  primaryLanguageCode: string;
  secondaryLanguageCode: string | null;
  cefrLevel: CommunityCefrLevel | null;
  topics: string[];
  visibility: CommunityVisibility;
  details: LibraryResourceDetails;
}

export interface LibraryResourceRecord {
  id: string;
  resourceType: LibraryResourceType;
  primaryLanguageCode: string;
  secondaryLanguageCode: string | null;
  cefrLevel: CommunityCefrLevel | null;
  topics: string[];
  createdByUserId: string;
  visibility: CommunityVisibility;
  moderationState: CommunityModerationState;
  reviewState: LibraryReviewState;
  createdAt: Date;
  updatedAt: Date;
  reviewedByUserId: string | null;
  reviewedAt: Date | null;
  provenanceRevision: number;
  details: LibraryResourceDetails;
  provenance: LibraryProvenanceRecord[];
}

export interface LibraryReviewAuditRecord {
  id: string;
  resourceId: string;
  actorUserId: string;
  previousState: LibraryReviewState;
  newState: LibraryReviewState;
  action: LibraryReviewAction;
  note: string | null;
  createdAt: Date;
}

export interface SubmitLibraryContributionInput {
  termsVersion?: unknown;
  rightsConfirmed?: unknown;
  reuseConsent?: unknown;
}

export interface LibraryContributionEventRecord {
  id: string;
  eventType: typeof LIBRARY_CONTRIBUTION_EVENT_TYPE;
  eventVersion: typeof LIBRARY_CONTRIBUTION_EVENT_VERSION;
  resourceId: string;
  contributorUserId: string;
  reviewAuditId: string;
  resourceType: LibraryContributionResourceType;
  termsVersion: typeof LIBRARY_CONTRIBUTION_TERMS_VERSION;
  rightsConfirmed: true;
  reuseConsent: true;
  occurredAt: Date;
  createdAt: Date;
}

export interface LibraryContributionSubmissionResult {
  resource: LibraryResourceRecord;
  audit: LibraryReviewAuditRecord;
  event: LibraryContributionEventRecord;
}

export interface LibraryPublicResource {
  id: string;
  resourceType: LibraryResourceType;
  primaryLanguageCode: string;
  secondaryLanguageCode: string | null;
  cefrLevel: CommunityCefrLevel | null;
  topics: string[];
  reviewState: 'VERIFIED';
  details: LibraryResourceDetails;
  provenance: LibraryPublicProvenance[];
  createdAt: Date;
  updatedAt: Date;
}

export interface LibraryPublicSearchPreview {
  title: string;
  excerpt: string;
}

export interface LibraryPublicSearchProvenance {
  attribution: string;
  license: LibraryPublicLicense;
}

export interface LibraryPublicSearchResult {
  id: string;
  resourceType: LibraryResourceType;
  primaryLanguageCode: string;
  secondaryLanguageCode: string | null;
  cefrLevel: CommunityCefrLevel | null;
  topics: string[];
  reviewState: 'VERIFIED';
  preview: LibraryPublicSearchPreview;
  provenance: LibraryPublicSearchProvenance[];
  createdAt: Date;
  updatedAt: Date;
}

export interface LibraryPublicSearchPage {
  items: LibraryPublicSearchResult[];
  nextCursor: string | null;
}

export interface LibraryReviewLicenseSummary {
  licenseKey: string;
  exists: boolean;
  displayName: string | null;
  canonicalUrl: string | null;
  attributionRequired: boolean | null;
  redistributionAllowed: LibraryRedistributionAllowed;
  derivativeConstraints: string | null;
  active: boolean;
  eligibleForPublicVerification: boolean;
}

export interface LibraryReviewProvenanceSummary {
  id: string;
  sourceType: LibrarySourceType;
  sourceId: string;
  sourceUrl: string | null;
  attribution: string;
  originalAuthorReference: string | null;
  license: LibraryReviewLicenseSummary;
  sourceHealth: LibrarySourceHealth;
}

export type LibrarySourceHealthReason = Phase06SourceHealthReason | 'NOT_APPLICABLE';

export interface LibrarySourceHealth {
  applicable: boolean;
  valid: boolean;
  reason: LibrarySourceHealthReason;
}

export type LibraryReviewEligibilityIssue =
  | 'PROVENANCE_REQUIRED'
  | 'LICENSE_UNKNOWN'
  | 'LICENSE_INACTIVE'
  | 'LICENSE_REDISTRIBUTION_UNSAFE'
  | 'MODERATION_INACTIVE'
  | 'SOURCE_INVALID';

export interface LibraryReviewEligibility {
  eligible: boolean;
  issues: LibraryReviewEligibilityIssue[];
}

export interface LibraryReviewQueueItem {
  resourceId: string;
  resourceType: LibraryResourceType;
  primaryLanguageCode: string;
  secondaryLanguageCode: string | null;
  cefrLevel: CommunityCefrLevel | null;
  topics: string[];
  reviewState: 'COMMUNITY_REVIEW';
  preview: LibraryPublicSearchPreview;
  updatedAt: Date;
  provenanceRevision: number;
  provenance: LibraryReviewProvenanceSummary[];
  verificationEligibility: LibraryReviewEligibility;
}

export interface LibraryReviewQueuePage {
  items: LibraryReviewQueueItem[];
  nextCursor: string | null;
}

export interface LibraryInvalidSourceQueueItem {
  resourceId: string;
  resourceType: LibraryResourceType;
  primaryLanguageCode: string;
  secondaryLanguageCode: string | null;
  preview: LibraryPublicSearchPreview;
  reviewState: 'VERIFIED';
  updatedAt: Date;
  provenanceRevision: number;
  sourceHealth: LibrarySourceHealth[];
  publicExposure: false;
}

export interface LibraryInvalidSourceQueuePage {
  items: LibraryInvalidSourceQueueItem[];
  nextCursor: string | null;
}

export interface LibraryReviewResourceDetail {
  id: string;
  resourceType: LibraryResourceType;
  primaryLanguageCode: string;
  secondaryLanguageCode: string | null;
  cefrLevel: CommunityCefrLevel | null;
  topics: string[];
  visibility: CommunityVisibility;
  moderationState: CommunityModerationState;
  reviewState: LibraryReviewState;
  createdAt: Date;
  updatedAt: Date;
  provenanceRevision: number;
  details: LibraryResourceDetails;
}

export interface LibraryReviewContributionEventSummary {
  id: string;
  eventType: typeof LIBRARY_CONTRIBUTION_EVENT_TYPE;
  eventVersion: typeof LIBRARY_CONTRIBUTION_EVENT_VERSION;
  resourceId: string;
  reviewAuditId: string;
  resourceType: LibraryContributionResourceType;
  termsVersion: typeof LIBRARY_CONTRIBUTION_TERMS_VERSION;
  rightsConfirmed: true;
  reuseConsent: true;
  occurredAt: Date;
  createdAt: Date;
}

export interface LibraryReviewDetail {
  resource: LibraryReviewResourceDetail;
  provenance: LibraryReviewProvenanceSummary[];
  reviewAuditHistory: LibraryReviewAuditRecord[];
  contributionEvents: LibraryReviewContributionEventSummary[];
  verificationEligibility: LibraryReviewEligibility;
}

export interface LibraryCollectionMemberRecord {
  collectionResourceId: string;
  memberResourceId: string;
  sortOrder: number;
  addedAt: Date;
}
