import {
  LIBRARY_RESOURCE_TYPES,
  LIBRARY_SEARCH_DEFAULT_LIMIT,
  LIBRARY_SEARCH_MAX_LIMIT,
  LIBRARY_SEARCH_MAX_QUERY_LENGTH,
  LIBRARY_REVIEW_ACTIONS,
  LIBRARY_REVIEW_STATES,
  LIBRARY_SOURCE_TYPES,
  type CreateLibraryResourceInput,
  type LibraryProvenanceInput,
  type LibraryResourceDetails,
  type LibraryResourceType,
  type LibraryReviewAction,
  type LibraryReviewState,
  type LibraryTransformationInput,
  type NormalizedLibraryLicenseInput,
  type NormalizedLibraryProvenanceInput,
  type NormalizedLibraryResourceInput,
  type VocabularyDetails,
  type SentenceDetails,
  type TranslationDetails,
  type GrammarItemDetails,
  type DialogueDetails,
  type IdiomDetails,
  type SlangDetails,
  type CulturalNoteDetails,
  type PronunciationDetails,
  type LearningCollectionDetails,
  type LibraryLicenseInput,
  type LibrarySearchInput,
  type NormalizedLibrarySearchInput,
} from './library.types';

const LANGUAGE_CODE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LICENSE_KEY_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,79}$/u;
const SOURCE_TYPE_PATTERN = /^[A-Z0-9_]{1,64}$/u;

export const LIBRARY_MAX_SOURCE_ID_LENGTH = 255;
export const LIBRARY_MAX_ATTRIBUTION_LENGTH = 2_000;
export const LIBRARY_MAX_IMPORT_BATCH_LENGTH = 120;
export const LIBRARY_MAX_TRANSFORMATION_HISTORY = 50;

export class LibraryValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'LibraryValidationError';
  }
}

export function normalizeLibraryLicenseInput(
  input: LibraryLicenseInput,
): NormalizedLibraryLicenseInput {
  const record = asRecord(input, 'LIBRARY_LICENSE_INVALID');
  const licenseKey = normalizeLicenseKey(record.licenseKey);
  const displayName = requiredText(record.displayName, 160, 'LIBRARY_REQUIRED_FIELD');
  const canonicalUrl = normalizeUrl(record.canonicalUrl, 'LIBRARY_LICENSE_URL_INVALID', false);
  if (!canonicalUrl) throw invalid('LIBRARY_LICENSE_URL_INVALID');
  const attributionRequired = requiredBoolean(record.attributionRequired, 'LIBRARY_REQUIRED_FIELD');
  const redistributionAllowed = normalizeNullableBoolean(record.redistributionAllowed, 'LIBRARY_LICENSE_REDISTRIBUTION_INVALID');
  const derivativeConstraints = optionalText(record.derivativeConstraints, 2_000, 'LIBRARY_LICENSE_CONSTRAINTS_INVALID');
  const active = record.active === undefined ? true : requiredBoolean(record.active, 'LIBRARY_LICENSE_ACTIVE_INVALID');
  const sourceNote = optionalText(record.sourceNote, 2_000, 'LIBRARY_LICENSE_SOURCE_NOTE_INVALID');

  return {
    licenseKey,
    displayName,
    canonicalUrl,
    attributionRequired,
    redistributionAllowed,
    derivativeConstraints,
    active,
    sourceNote,
  };
}

export function normalizeLibraryResourceInput(
  input: CreateLibraryResourceInput,
): NormalizedLibraryResourceInput {
  const record = asRecord(input, 'LIBRARY_RESOURCE_INVALID');
  const resourceType = normalizeResourceType(record.resourceType);
  const primaryLanguageCode = normalizeLanguageCode(record.primaryLanguageCode);
  const secondaryLanguageCode = normalizeOptionalLanguageCode(record.secondaryLanguageCode);
  if (resourceType === 'TRANSLATION' && !secondaryLanguageCode) {
    throw invalid('LIBRARY_SECONDARY_LANGUAGE_REQUIRED');
  }
  if (secondaryLanguageCode && secondaryLanguageCode === primaryLanguageCode) {
    throw invalid('LIBRARY_SECONDARY_LANGUAGE_DUPLICATE');
  }

  return {
    resourceType,
    primaryLanguageCode,
    secondaryLanguageCode,
    cefrLevel: normalizeCefrLevel(record.cefrLevel),
    topics: normalizeTopics(record.topics),
    visibility: normalizeVisibility(record.visibility),
    details: normalizeResourceDetails(resourceType, record.details),
  };
}

export function normalizeLibrarySearchInput(
  input: LibrarySearchInput,
): NormalizedLibrarySearchInput {
  const record = asRecord(input, 'LIBRARY_SEARCH_INVALID');
  const q = normalizeSearchQuery(record.q);
  const languageCode = normalizeOptionalLanguageCode(record.language);
  const resourceType = normalizeOptionalResourceType(record.type);
  const topic = normalizeSearchTopic(record.topic);
  const cefrLevel = normalizeCefrLevel(record.level);
  const cursor = optionalText(record.cursor, 512, 'LIBRARY_INVALID_CURSOR') ?? undefined;
  const limit = normalizeSearchLimit(record.limit);

  return {
    filters: { q, languageCode, resourceType, topic, cefrLevel },
    cursor,
    limit,
  };
}

export function normalizeLibraryProvenanceInput(
  input: LibraryProvenanceInput,
): NormalizedLibraryProvenanceInput {
  const record = asRecord(input, 'LIBRARY_PROVENANCE_INVALID');
  const sourceType = normalizeSourceType(record.sourceType);
  const sourceId = requiredText(record.sourceId, LIBRARY_MAX_SOURCE_ID_LENGTH, 'LIBRARY_SOURCE_ID_INVALID');
  if (!SOURCE_TYPE_PATTERN.test(sourceType)) throw invalid('LIBRARY_SOURCE_TYPE_INVALID');
  const sourceUrl = normalizeUrl(record.sourceUrl, 'LIBRARY_SOURCE_URL_INVALID', true);
  const licenseKey = normalizeLicenseKey(record.licenseKey);
  const attribution = requiredText(record.attribution, LIBRARY_MAX_ATTRIBUTION_LENGTH, 'LIBRARY_ATTRIBUTION_INVALID');

  return {
    sourceType,
    sourceId,
    sourceUrl,
    licenseKey,
    attribution,
    originalAuthorReference: optionalText(record.originalAuthorReference, 255, 'LIBRARY_AUTHOR_REFERENCE_INVALID'),
    originalContributorUserId: normalizeOptionalUuid(record.originalContributorUserId),
    importBatch: optionalText(record.importBatch, LIBRARY_MAX_IMPORT_BATCH_LENGTH, 'LIBRARY_IMPORT_BATCH_INVALID'),
    transformationHistory: normalizeTransformationHistory(record.transformationHistory),
    sourcePostId: normalizeOptionalUuid(record.sourcePostId),
    sourceResponseId: normalizeOptionalUuid(record.sourceResponseId),
    sourceCandidateId: normalizeOptionalUuid(record.sourceCandidateId),
    sourceAcceptanceId: normalizeOptionalUuid(record.sourceAcceptanceId),
  };
}

export function mergeProvenanceEntries(
  existing: readonly NormalizedLibraryProvenanceInput[],
  incoming: readonly LibraryProvenanceInput[],
): NormalizedLibraryProvenanceInput[] {
  return mergeNormalizedProvenanceEntries(
    existing,
    incoming.map((candidate) => normalizeLibraryProvenanceInput(candidate)),
  );
}

export function mergeNormalizedProvenanceEntries(
  existing: readonly NormalizedLibraryProvenanceInput[],
  incoming: readonly NormalizedLibraryProvenanceInput[],
): NormalizedLibraryProvenanceInput[] {
  const result = existing.map(cloneProvenance);
  const byKey = new Map(result.map((entry) => [provenanceKey(entry), entry]));

  for (const normalized of incoming) {
    const key = provenanceKey(normalized);
    const prior = byKey.get(key);
    if (!prior) {
      const clone = cloneProvenance(normalized);
      result.push(clone);
      byKey.set(key, clone);
      continue;
    }
    if (JSON.stringify(prior) !== JSON.stringify(normalized)) {
      throw invalid('LIBRARY_PROVENANCE_DUPLICATE');
    }
  }

  return result;
}

export function assertLibraryReviewTransition(
  previousState: LibraryReviewState,
  nextState: LibraryReviewState,
): LibraryReviewAction {
  const transitions: Record<string, LibraryReviewAction> = {
    'DRAFT:COMMUNITY_REVIEW': 'SUBMIT',
    'COMMUNITY_REVIEW:VERIFIED': 'VERIFY',
    'COMMUNITY_REVIEW:REJECTED': 'REJECT',
    'VERIFIED:REJECTED': 'INVALIDATE',
    'REJECTED:DRAFT': 'REOPEN',
  };
  const action = transitions[previousState + ':' + nextState];
  if (!action || !LIBRARY_REVIEW_ACTIONS.includes(action)) {
    throw invalid('LIBRARY_REVIEW_TRANSITION_INVALID');
  }
  return action;
}

export function normalizeReviewState(input: unknown): LibraryReviewState {
  const value = normalizeEnumString(input, 'LIBRARY_REVIEW_STATE_INVALID');
  if (!LIBRARY_REVIEW_STATES.includes(value as LibraryReviewState)) {
    throw invalid('LIBRARY_REVIEW_STATE_INVALID');
  }
  return value as LibraryReviewState;
}

function normalizeResourceType(input: unknown): LibraryResourceType {
  const value = normalizeEnumString(input, 'LIBRARY_RESOURCE_TYPE_INVALID');
  if (!LIBRARY_RESOURCE_TYPES.includes(value as LibraryResourceType)) {
    throw invalid('LIBRARY_RESOURCE_TYPE_INVALID');
  }
  return value as LibraryResourceType;
}

function normalizeOptionalResourceType(input: unknown): LibraryResourceType | null {
  if (input === undefined || input === null || input === '') return null;
  return normalizeResourceType(input);
}

function normalizeSourceType(input: unknown): NormalizedLibraryProvenanceInput['sourceType'] {
  const value = normalizeEnumString(input, 'LIBRARY_SOURCE_TYPE_INVALID');
  if (!LIBRARY_SOURCE_TYPES.includes(value as NormalizedLibraryProvenanceInput['sourceType'])) {
    throw invalid('LIBRARY_SOURCE_TYPE_INVALID');
  }
  return value as NormalizedLibraryProvenanceInput['sourceType'];
}

function normalizeLanguageCode(input: unknown): string {
  if (typeof input !== 'string') throw invalid('LIBRARY_LANGUAGE_INVALID');
  const value = input.normalize('NFKC').trim().toLowerCase();
  if (value.length < 2 || value.length > 35 || !LANGUAGE_CODE_PATTERN.test(value)) {
    throw invalid('LIBRARY_LANGUAGE_INVALID');
  }
  return value;
}

function normalizeOptionalLanguageCode(input: unknown): string | null {
  if (input === undefined || input === null || input === '') return null;
  return normalizeLanguageCode(input);
}

function normalizeCefrLevel(input: unknown): NormalizedLibraryResourceInput['cefrLevel'] {
  if (input === undefined || input === null || input === '') return null;
  const value = normalizeEnumString(input, 'LIBRARY_CEFR_INVALID');
  if (!['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].includes(value)) {
    throw invalid('LIBRARY_CEFR_INVALID');
  }
  return value as NormalizedLibraryResourceInput['cefrLevel'];
}

function normalizeSearchQuery(input: unknown): string | null {
  if (input === undefined || input === null || input === '') return null;
  if (typeof input !== 'string') throw invalid('LIBRARY_SEARCH_QUERY_INVALID');
  const value = normalizeText(input);
  if (!value) return null;
  if (Array.from(value).length > LIBRARY_SEARCH_MAX_QUERY_LENGTH) {
    throw invalid('LIBRARY_SEARCH_QUERY_INVALID');
  }
  return value;
}

function normalizeSearchTopic(input: unknown): string | null {
  if (input === undefined || input === null || input === '') return null;
  if (typeof input !== 'string') throw invalid('LIBRARY_SEARCH_TOPIC_INVALID');
  const topic = input
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, '-');
  if (
    !topic ||
    Array.from(topic).length > 80 ||
    !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(topic)
  ) {
    throw invalid('LIBRARY_SEARCH_TOPIC_INVALID');
  }
  return topic;
}

function normalizeSearchLimit(input: unknown): number {
  if (input === undefined || input === null || input === '') return LIBRARY_SEARCH_DEFAULT_LIMIT;
  if (
    typeof input !== 'number' ||
    !Number.isInteger(input) ||
    input < 1 ||
    input > LIBRARY_SEARCH_MAX_LIMIT
  ) {
    throw invalid('LIBRARY_SEARCH_LIMIT_INVALID');
  }
  return input;
}

function normalizeTopics(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > 20) throw invalid('LIBRARY_TOPICS_INVALID');
  const topics: string[] = [];
  for (const value of input) {
    if (typeof value !== 'string') throw invalid('LIBRARY_TOPICS_INVALID');
    const topic = value
      .normalize('NFKC')
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/gu, '-');
    if (
      topic.length === 0 ||
      Array.from(topic).length > 80 ||
      !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(topic)
    ) {
      throw invalid('LIBRARY_TOPICS_INVALID');
    }
    if (!topics.includes(topic)) topics.push(topic);
  }
  return topics;
}

function normalizeVisibility(input: unknown): NormalizedLibraryResourceInput['visibility'] {
  if (input === undefined || input === null || input === '') return 'PRIVATE';
  const value = normalizeEnumString(input, 'LIBRARY_VISIBILITY_INVALID');
  if (value !== 'PUBLIC' && value !== 'PRIVATE') throw invalid('LIBRARY_VISIBILITY_INVALID');
  return value;
}

function normalizeResourceDetails(
  resourceType: LibraryResourceType,
  input: unknown,
): LibraryResourceDetails {
  const record = asRecord(input, 'LIBRARY_DETAILS_INVALID');
  switch (resourceType) {
    case 'VOCABULARY':
      return {
        resourceType,
        term: requiredText(record.term, 500, 'LIBRARY_REQUIRED_FIELD'),
        definition: requiredText(record.definition, 5_000, 'LIBRARY_REQUIRED_FIELD'),
        partOfSpeech: optionalText(record.partOfSpeech, 80, 'LIBRARY_OPTIONAL_FIELD_INVALID'),
        exampleSentence: optionalText(record.exampleSentence, 20_000, 'LIBRARY_OPTIONAL_FIELD_INVALID'),
      } satisfies VocabularyDetails & { resourceType: 'VOCABULARY' };
    case 'SENTENCE':
      return {
        resourceType,
        text: requiredText(record.text, 20_000, 'LIBRARY_REQUIRED_FIELD'),
        context: optionalText(record.context, 5_000, 'LIBRARY_OPTIONAL_FIELD_INVALID'),
      } satisfies SentenceDetails & { resourceType: 'SENTENCE' };
    case 'TRANSLATION':
      return {
        resourceType,
        sourceText: requiredText(record.sourceText, 20_000, 'LIBRARY_REQUIRED_FIELD'),
        translatedText: requiredText(record.translatedText, 20_000, 'LIBRARY_REQUIRED_FIELD'),
      } satisfies TranslationDetails & { resourceType: 'TRANSLATION' };
    case 'GRAMMAR_ITEM':
      return {
        resourceType,
        title: requiredText(record.title, 200, 'LIBRARY_REQUIRED_FIELD'),
        explanation: requiredText(record.explanation, 10_000, 'LIBRARY_REQUIRED_FIELD'),
        pattern: optionalText(record.pattern, 2_000, 'LIBRARY_OPTIONAL_FIELD_INVALID'),
        exampleText: optionalText(record.exampleText, 20_000, 'LIBRARY_OPTIONAL_FIELD_INVALID'),
      } satisfies GrammarItemDetails & { resourceType: 'GRAMMAR_ITEM' };
    case 'DIALOGUE':
      return {
        resourceType,
        title: requiredText(record.title, 200, 'LIBRARY_REQUIRED_FIELD'),
        turns: normalizeDialogueTurns(record.turns),
      } satisfies DialogueDetails & { resourceType: 'DIALOGUE' };
    case 'IDIOM':
      return {
        resourceType,
        expression: requiredText(record.expression, 500, 'LIBRARY_REQUIRED_FIELD'),
        meaning: requiredText(record.meaning, 5_000, 'LIBRARY_REQUIRED_FIELD'),
        usageNote: optionalText(record.usageNote, 5_000, 'LIBRARY_OPTIONAL_FIELD_INVALID'),
      } satisfies IdiomDetails & { resourceType: 'IDIOM' };
    case 'SLANG':
      return {
        resourceType,
        expression: requiredText(record.expression, 500, 'LIBRARY_REQUIRED_FIELD'),
        meaning: requiredText(record.meaning, 5_000, 'LIBRARY_REQUIRED_FIELD'),
        register: optionalText(record.register, 80, 'LIBRARY_OPTIONAL_FIELD_INVALID'),
        usageNote: optionalText(record.usageNote, 5_000, 'LIBRARY_OPTIONAL_FIELD_INVALID'),
      } satisfies SlangDetails & { resourceType: 'SLANG' };
    case 'CULTURAL_NOTE':
      return {
        resourceType,
        title: requiredText(record.title, 200, 'LIBRARY_REQUIRED_FIELD'),
        body: requiredText(record.body, 20_000, 'LIBRARY_REQUIRED_FIELD'),
      } satisfies CulturalNoteDetails & { resourceType: 'CULTURAL_NOTE' };
    case 'PRONUNCIATION':
      return {
        resourceType,
        term: requiredText(record.term, 500, 'LIBRARY_REQUIRED_FIELD'),
        phonetic: requiredText(record.phonetic, 500, 'LIBRARY_REQUIRED_FIELD'),
        notes: optionalText(record.notes, 5_000, 'LIBRARY_OPTIONAL_FIELD_INVALID'),
      } satisfies PronunciationDetails & { resourceType: 'PRONUNCIATION' };
    case 'LEARNING_COLLECTION':
      return {
        resourceType,
        title: requiredText(record.title, 200, 'LIBRARY_REQUIRED_FIELD'),
        description: requiredText(record.description, 2_000, 'LIBRARY_REQUIRED_FIELD'),
      } satisfies LearningCollectionDetails & { resourceType: 'LEARNING_COLLECTION' };
  }
}

function normalizeDialogueTurns(input: unknown): DialogueDetails['turns'] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) {
    throw invalid('LIBRARY_REQUIRED_FIELD');
  }
  return input.map((turn) => {
    const record = asRecord(turn, 'LIBRARY_DIALOGUE_TURN_INVALID');
    return {
      speaker: requiredText(record.speaker, 120, 'LIBRARY_REQUIRED_FIELD'),
      text: requiredText(record.text, 20_000, 'LIBRARY_REQUIRED_FIELD'),
      translation: optionalText(record.translation, 20_000, 'LIBRARY_OPTIONAL_FIELD_INVALID'),
    };
  });
}

function normalizeTransformationHistory(input: unknown): NormalizedLibraryProvenanceInput['transformationHistory'] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > LIBRARY_MAX_TRANSFORMATION_HISTORY) {
    throw invalid('LIBRARY_TRANSFORMATION_HISTORY_INVALID');
  }
  return input.map((value) => {
    const record = asRecord(value as LibraryTransformationInput, 'LIBRARY_TRANSFORMATION_HISTORY_INVALID');
    const operation = requiredText(record.operation, 80, 'LIBRARY_TRANSFORMATION_HISTORY_INVALID');
    const metadata = normalizeMetadata(record.metadata);
    let occurredAt = new Date().toISOString();
    if (record.occurredAt !== undefined) {
      if (typeof record.occurredAt !== 'string' || Number.isNaN(Date.parse(record.occurredAt))) {
        throw invalid('LIBRARY_TRANSFORMATION_HISTORY_INVALID');
      }
      occurredAt = new Date(record.occurredAt).toISOString();
    }
    return { operation, metadata, occurredAt };
  });
}

function normalizeMetadata(input: unknown): Record<string, string | number | boolean> | null {
  if (input === undefined || input === null) return null;
  const record = asRecord(input, 'LIBRARY_TRANSFORMATION_HISTORY_INVALID');
  const entries = Object.entries(record);
  if (entries.length > 20) throw invalid('LIBRARY_TRANSFORMATION_HISTORY_INVALID');
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(key)) throw invalid('LIBRARY_TRANSFORMATION_HISTORY_INVALID');
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      throw invalid('LIBRARY_TRANSFORMATION_HISTORY_INVALID');
    }
    result[key] = value;
  }
  return result;
}

function normalizeLicenseKey(input: unknown): string {
  if (typeof input !== 'string') throw invalid('LIBRARY_LICENSE_INVALID');
  const value = input.normalize('NFKC').trim().toUpperCase();
  if (!LICENSE_KEY_PATTERN.test(value)) throw invalid('LIBRARY_LICENSE_INVALID');
  return value;
}

function normalizeUrl(input: unknown, code: string, optional: boolean): string | null {
  if (input === undefined || input === null || input === '') {
    if (optional) return null;
    throw invalid(code);
  }
  if (typeof input !== 'string') throw invalid(code);
  const value = input.normalize('NFKC').trim();
  if (value.length === 0 || value.length > 2_048) throw invalid(code);
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('unsupported protocol');
  } catch {
    throw invalid(code);
  }
  return value;
}

function normalizeEnumString(input: unknown, code: string): string {
  if (typeof input !== 'string') throw invalid(code);
  const value = input.normalize('NFKC').trim().toUpperCase();
  if (!value) throw invalid(code);
  return value;
}

function normalizeOptionalUuid(input: unknown): string | null {
  if (input === undefined || input === null || input === '') return null;
  if (typeof input !== 'string' || !UUID_PATTERN.test(input.trim())) {
    throw invalid('LIBRARY_REFERENCE_ID_INVALID');
  }
  return input.trim().toLowerCase();
}

function requiredBoolean(input: unknown, code: string): boolean {
  if (typeof input !== 'boolean') throw invalid(code);
  return input;
}

function normalizeNullableBoolean(input: unknown, code: string): boolean | null {
  if (input === undefined || input === null || input === '') return null;
  return requiredBoolean(input, code);
}

function requiredText(input: unknown, maxLength: number, code: string): string {
  if (typeof input !== 'string') throw invalid(code);
  const value = normalizeText(input);
  if (!value || Array.from(value).length > maxLength) throw invalid(code);
  return value;
}

function optionalText(input: unknown, maxLength: number, code: string): string | null {
  if (input === undefined || input === null || input === '') return null;
  return requiredText(input, maxLength, code);
}

function normalizeText(input: string): string {
  return input.normalize('NFKC').replace(/\r\n?/gu, '\n').trim();
}

function asRecord(input: unknown, code: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw invalid(code);
  return input as Record<string, unknown>;
}

function invalid(code: string): LibraryValidationError {
  return new LibraryValidationError(code);
}

function provenanceKey(entry: NormalizedLibraryProvenanceInput): string {
  return entry.sourceType + ':' + entry.sourceId;
}

function cloneProvenance(entry: NormalizedLibraryProvenanceInput): NormalizedLibraryProvenanceInput {
  return {
    ...entry,
    transformationHistory: entry.transformationHistory.map((transformation) => ({
      ...transformation,
      metadata: transformation.metadata ? { ...transformation.metadata } : null,
    })),
  };
}
