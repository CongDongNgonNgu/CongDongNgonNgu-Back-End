import type {
  CommunityCefrLevel,
  CommunityModerationState,
  CommunityVisibility,
} from '../community/community.types';
import type { RoleKey } from '../identity/identity.types';

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

export interface LibraryCollectionMemberRecord {
  collectionResourceId: string;
  memberResourceId: string;
  sortOrder: number;
  addedAt: Date;
}
