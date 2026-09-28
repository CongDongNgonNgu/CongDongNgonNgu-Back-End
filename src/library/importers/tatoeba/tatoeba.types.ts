export const TATOEBA_PROJECT_LANGUAGES = [
  'vi',
  'en',
  'zh',
  'ja',
  'ko',
  'fr',
  'de',
  'es',
] as const;

export type TatoebaProjectLanguage = typeof TATOEBA_PROJECT_LANGUAGES[number];
export type TatoebaLicense = 'CC BY 2.0 FR' | 'CC0 1.0';

export interface TatoebaConfiguredDirection {
  sourceLanguage: TatoebaProjectLanguage;
  targetLanguage: TatoebaProjectLanguage;
}

export interface TatoebaBulkSentenceRow {
  sentenceId: string;
  tatoebaLanguage: string;
  text: string;
  username: string | null;
  dateAdded: string;
  dateLastModified: string;
  lineNumber: number;
}

export interface TatoebaCc0SentenceRow {
  sentenceId: string;
  tatoebaLanguage: string;
  text: string;
  dateLastModified: string;
  lineNumber: number;
}

export interface TatoebaLinkRow {
  sentenceId: string;
  translationId: string;
  lineNumber: number;
}

export interface TatoebaApiSentenceFacts {
  sentenceId: string;
  tatoebaLanguage: string | null;
  text: string;
  license: string | null;
  owner: string | null;
  isUnapproved: boolean;
}

export interface TatoebaApiSentenceCheck {
  facts: TatoebaApiSentenceFacts;
  checkedAt: string;
}

export interface TatoebaHttpResponse {
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: string | Uint8Array;
}

export interface TatoebaHttpRequest {
  url: string;
  signal: AbortSignal;
  maxResponseBytes: number;
}

export type TatoebaApiTransport = (
  request: TatoebaHttpRequest,
) => Promise<TatoebaHttpResponse>;

export interface TatoebaApiClientOptions {
  transport?: TatoebaApiTransport;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  retries?: number;
  maxResponseBytes?: number;
  now?: () => string;
}

export interface TatoebaSnapshotArtifact {
  kind: 'sentences_detailed' | 'sentences_cc0' | 'links';
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

export interface TatoebaSnapshotMetadata {
  snapshotId: string;
  snapshotRetrievedAt: string | null;
  artifacts: TatoebaSnapshotArtifact[];
}

export interface TatoebaValidatedSentenceCandidate {
  provider: 'TATOEBA';
  sentenceId: string;
  projectLanguage: TatoebaProjectLanguage;
  text: string;
  license: TatoebaLicense;
  owner: string | null;
  sourceUrl: string;
  sourceIdentity: string;
  attribution: string;
  importBatch: string;
  snapshotId: string;
  apiCheckedAt: string;
  transformationNote: null;
}

export interface TatoebaProvenancePreview {
  sourceId: string;
  sourceUrl: string;
  license: TatoebaLicense;
  owner: string | null;
  attribution: string;
  endpointSentenceId: string;
  transformationNote: null;
}

export interface TatoebaTranslationCandidate {
  provider: 'TATOEBA';
  inputPairIdentity: string;
  durableIdentity: string;
  primaryLanguageCode: TatoebaProjectLanguage;
  secondaryLanguageCode: TatoebaProjectLanguage;
  sourceSentenceId: string;
  targetSentenceId: string;
  sourceText: string;
  translatedText: string;
  sourceProvenance: TatoebaProvenancePreview;
  targetProvenance: TatoebaProvenancePreview;
}

export interface TatoebaQuarantineEntry {
  kind: 'SENTENCE' | 'LINK';
  sourceId: string | null;
  relatedSourceId: string | null;
  reason: string;
  details: Record<string, string | number | boolean | null>;
}

export interface TatoebaDryRunReport {
  reportVersion: 1;
  mode: 'DRY_RUN';
  dbPreflight: 'SKIPPED_08D3A';
  runStartedAt: string;
  snapshot: TatoebaSnapshotMetadata;
  configuration: {
    languages: TatoebaProjectLanguage[];
    directions: TatoebaConfiguredDirection[];
    sentenceLimit: number;
    linkLimit: number;
    apiConcurrency: number;
    apiTimeoutMs: number;
    apiRetries: number;
    apiMaxResponseBytes: number;
  };
  counts: {
    sentencesDiscovered: number;
    sentencesParsed: number;
    sentencesEligible: number;
    unsupportedLanguage: number;
    malformedRows: number;
    duplicateSentences: number;
    apiChecked: number;
    apiNotFound: number;
    apiUnavailable: number;
    apiLicenseProblem: number;
    apiLicenseUnknown: number;
    apiUnapproved: number;
    licenseCcBy: number;
    licenseCc0: number;
    ownerRequired: number;
    ownerMismatch: number;
    textTooLong: number;
    textMismatch: number;
    languageMismatch: number;
    cc0Mismatch: number;
    quarantinedSentences: number;
    linksDiscovered: number;
    linksParsed: number;
    reciprocalPairsCollapsed: number;
    missingLinkEndpoints: number;
    sameLanguageLinks: number;
    ambiguousLanguageLinks: number;
    duplicateInputPairs: number;
    translationCandidates: number;
    directionConflicts: number;
    wouldCreateSentences: number;
    wouldCreateTranslations: number;
  };
  candidates: {
    sentences: TatoebaValidatedSentenceCandidate[];
    translations: TatoebaTranslationCandidate[];
  };
  sentenceCandidatesTruncated: boolean;
  sentenceCandidatesOmitted: number;
  translationCandidatesTruncated: boolean;
  translationCandidatesOmitted: number;
  quarantine: TatoebaQuarantineEntry[];
  quarantineTruncated: boolean;
  quarantineOmitted: number;
}
