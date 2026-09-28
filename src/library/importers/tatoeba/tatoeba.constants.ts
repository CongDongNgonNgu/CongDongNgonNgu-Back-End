import type { TatoebaLicense, TatoebaProjectLanguage } from './tatoeba.types';

export const TATOEBA_API_ORIGIN = 'https://api.tatoeba.org';
export const TATOEBA_API_HOST = 'api.tatoeba.org';
export const TATOEBA_SENTENCE_URL_ORIGIN = 'https://tatoeba.org/en/sentences/show';

export const TATOEBA_LICENSE_URLS: Record<TatoebaLicense, string> = {
  'CC BY 2.0 FR': 'https://creativecommons.org/licenses/by/2.0/fr/',
  'CC0 1.0': 'https://creativecommons.org/publicdomain/zero/1.0/',
};

export const TATOEBA_SUPPORTED_LICENSES = ['CC BY 2.0 FR', 'CC0 1.0'] as const;

export const TATOEBA_LANGUAGE_MAPPING: Record<string, TatoebaProjectLanguage> = {
  vie: 'vi',
  eng: 'en',
  cmn: 'zh',
  jpn: 'ja',
  kor: 'ko',
  fra: 'fr',
  deu: 'de',
  spa: 'es',
};

export const TATOEBA_SUPPORTED_PROJECT_LANGUAGES = [
  'vi',
  'en',
  'zh',
  'ja',
  'ko',
  'fr',
  'de',
  'es',
] as const satisfies readonly TatoebaProjectLanguage[];

export const TATOEBA_MAX_ID_DIGITS = 40;
export const TATOEBA_MAX_LINE_LENGTH = 100_000;
// These are internal dry-run evidence budgets, not Tatoeba provider limits.
export const TATOEBA_MAX_REPORT_BYTES = 4_000_000;
export const TATOEBA_MAX_REPORT_CANDIDATE_ROWS = 256;
export const TATOEBA_MAX_REPORT_QUARANTINE_ROWS = 256;
export const TATOEBA_MAX_REPORT_SENTENCE_SAMPLE_BYTES = 1_000_000;
export const TATOEBA_MAX_REPORT_TRANSLATION_SAMPLE_BYTES = 1_000_000;
export const TATOEBA_MAX_REPORT_QUARANTINE_SAMPLE_BYTES = 1_000_000;
export const TATOEBA_MAX_ATTRIBUTION_LENGTH = 2_000;
export const TATOEBA_MAX_IMPORT_BATCH_LENGTH = 120;
export const TATOEBA_MAX_CC0_SCAN_ROWS = 5_000_000;
export const TATOEBA_MAX_API_TIMEOUT_MS = 60_000;
export const TATOEBA_MAX_API_RESPONSE_BYTES = 1_048_576;

export const TATOEBA_DEFAULT_LIMITS = {
  apiConcurrency: 4,
  apiTimeoutMs: 8_000,
  apiRetries: 2,
  apiMaxResponseBytes: 128_000,
} as const;

export const TATOEBA_RETRY_AFTER_MAX_MS = 2_000;
export const TATOEBA_RETRY_BACKOFF_BASE_MS = 100;

export const TATOEBA_EXPORT_COLUMNS = {
  sentencesDetailed: 6,
  sentencesCc0: 4,
  links: 2,
} as const;

export const TATOEBA_SOURCE_TYPE = 'OPEN_DATASET' as const;
export const TATOEBA_PROVIDER = 'TATOEBA' as const;
