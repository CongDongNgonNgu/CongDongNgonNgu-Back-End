import { promises as fs } from 'node:fs';
import { extname } from 'node:path';

import {
  TATOEBA_DEFAULT_LIMITS,
  TATOEBA_MAX_CC0_SCAN_ROWS,
  TATOEBA_MAX_API_RESPONSE_BYTES,
  TATOEBA_MAX_API_TIMEOUT_MS,
  TATOEBA_MAX_REPORT_ROWS,
} from './tatoeba.constants';
import { TatoebaSentenceApiClient } from './tatoeba.api-client';
import { hashTatoebaArtifact, readCc0SentenceRows, readDetailedSentenceRows, readLinkRows } from './tatoeba.bulk-reader';
import { TatoebaImportError, tatoebaError } from './tatoeba.errors';
import { buildTatoebaTranslationCandidates } from './tatoeba.direct-links';
import { deterministicSnapshotId, compareSentenceIds } from './tatoeba.identities';
import { mapTatoebaLanguage } from './tatoeba.languages';
import { validateTatoebaSentenceCandidate } from './tatoeba.validation';
import type {
  TatoebaApiSentenceCheck,
  TatoebaBulkSentenceRow,
  TatoebaConfiguredDirection,
  TatoebaDryRunReport,
  TatoebaQuarantineEntry,
  TatoebaSnapshotMetadata,
  TatoebaValidatedSentenceCandidate,
} from './tatoeba.types';

export type { TatoebaApiSentenceCheck } from './tatoeba.types';

export interface TatoebaDryRunOptions {
  sentencesDetailedPath: string;
  sentencesCc0Path: string;
  linksPath: string;
  languages: TatoebaDryRunReport['configuration']['languages'];
  directions: TatoebaConfiguredDirection[];
  sentenceLimit: number;
  linkLimit: number;
  apiConcurrency?: number;
  apiTimeoutMs?: number;
  apiRetries?: number;
  apiMaxResponseBytes?: number;
  apiClient?: Pick<TatoebaSentenceApiClient, 'getSentence'>;
  now?: () => string;
}

interface ApiOutcome {
  row: TatoebaBulkSentenceRow;
  result?: TatoebaApiSentenceCheck;
  error?: TatoebaImportError;
}

const MAX_SENTENCE_LIMIT = 10_000;
const MAX_LINK_LIMIT = 20_000;
const MAX_API_CONCURRENCY = 16;

function assertRunBounds(options: TatoebaDryRunOptions): Required<Pick<TatoebaDryRunOptions, 'apiConcurrency' | 'apiTimeoutMs' | 'apiRetries' | 'apiMaxResponseBytes'>> {
  const apiConcurrency = options.apiConcurrency ?? TATOEBA_DEFAULT_LIMITS.apiConcurrency;
  const apiTimeoutMs = options.apiTimeoutMs ?? TATOEBA_DEFAULT_LIMITS.apiTimeoutMs;
  const apiRetries = options.apiRetries ?? TATOEBA_DEFAULT_LIMITS.apiRetries;
  const apiMaxResponseBytes = options.apiMaxResponseBytes ?? TATOEBA_DEFAULT_LIMITS.apiMaxResponseBytes;
  if (
    !options.sentencesDetailedPath ||
    !options.sentencesCc0Path ||
    !options.linksPath ||
    !Number.isSafeInteger(options.sentenceLimit) ||
    options.sentenceLimit <= 0 ||
    options.sentenceLimit > MAX_SENTENCE_LIMIT ||
    !Number.isSafeInteger(options.linkLimit) ||
    options.linkLimit <= 0 ||
    options.linkLimit > MAX_LINK_LIMIT ||
    !Number.isSafeInteger(apiConcurrency) ||
    apiConcurrency <= 0 ||
    apiConcurrency > MAX_API_CONCURRENCY ||
    !Number.isSafeInteger(apiTimeoutMs) ||
    apiTimeoutMs <= 0 ||
    apiTimeoutMs > TATOEBA_MAX_API_TIMEOUT_MS ||
    !Number.isSafeInteger(apiRetries) ||
    apiRetries < 0 ||
    apiRetries > 5 ||
    !Number.isSafeInteger(apiMaxResponseBytes) ||
    apiMaxResponseBytes <= 0 ||
    apiMaxResponseBytes > TATOEBA_MAX_API_RESPONSE_BYTES
  ) {
    throw tatoebaError('TATOEBA_IMPORT_ARGUMENT_INVALID', 'Tatoeba dry-run bounds or input paths are invalid.');
  }
  const configuredLanguages = new Set(options.languages);
  if (configuredLanguages.size !== options.languages.length || options.languages.length === 0) {
    throw tatoebaError('TATOEBA_IMPORT_ARGUMENT_INVALID', 'Tatoeba dry-run languages must be unique and non-empty.');
  }
  for (const direction of options.directions) {
    if (!configuredLanguages.has(direction.sourceLanguage) || !configuredLanguages.has(direction.targetLanguage)) {
      throw tatoebaError('TATOEBA_IMPORT_ARGUMENT_INVALID', 'Configured directions must use selected languages.');
    }
  }
  return { apiConcurrency, apiTimeoutMs, apiRetries, apiMaxResponseBytes };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function runWorker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index]);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

function addQuarantine(
  quarantine: TatoebaQuarantineEntry[],
  entry: TatoebaQuarantineEntry,
): void {
  if (quarantine.length < TATOEBA_MAX_REPORT_ROWS) quarantine.push(entry);
}

function sentenceErrorCount(
  counts: TatoebaDryRunReport['counts'],
  reason: string,
): void {
  switch (reason) {
    case 'TATOEBA_UNSUPPORTED_LANGUAGE': counts.unsupportedLanguage += 1; break;
    case 'TATOEBA_API_NOT_FOUND': counts.apiNotFound += 1; break;
    case 'TATOEBA_API_UNAVAILABLE': counts.apiUnavailable += 1; break;
    case 'TATOEBA_LICENSE_PROBLEM': counts.apiLicenseProblem += 1; break;
    case 'TATOEBA_LICENSE_UNKNOWN': counts.apiLicenseUnknown += 1; break;
    case 'TATOEBA_UNAPPROVED': counts.apiUnapproved += 1; break;
    case 'TATOEBA_OWNER_REQUIRED': counts.ownerRequired += 1; break;
    case 'TATOEBA_OWNER_MISMATCH': counts.ownerMismatch += 1; break;
    case 'TATOEBA_TEXT_MISMATCH': counts.textMismatch += 1; break;
    case 'TATOEBA_LANGUAGE_MISMATCH': counts.languageMismatch += 1; break;
    case 'TATOEBA_CC0_MISMATCH': counts.cc0Mismatch += 1; break;
    default: break;
  }
}

function emptyCounts(): TatoebaDryRunReport['counts'] {
  return {
    sentencesDiscovered: 0,
    sentencesParsed: 0,
    sentencesEligible: 0,
    unsupportedLanguage: 0,
    malformedRows: 0,
    duplicateSentences: 0,
    apiChecked: 0,
    apiNotFound: 0,
    apiUnavailable: 0,
    apiLicenseProblem: 0,
    apiLicenseUnknown: 0,
    apiUnapproved: 0,
    licenseCcBy: 0,
    licenseCc0: 0,
    ownerRequired: 0,
    ownerMismatch: 0,
    textMismatch: 0,
    languageMismatch: 0,
    cc0Mismatch: 0,
    quarantinedSentences: 0,
    linksDiscovered: 0,
    linksParsed: 0,
    reciprocalPairsCollapsed: 0,
    missingLinkEndpoints: 0,
    sameLanguageLinks: 0,
    ambiguousLanguageLinks: 0,
    duplicateInputPairs: 0,
    translationCandidates: 0,
    directionConflicts: 0,
    wouldCreateSentences: 0,
    wouldCreateTranslations: 0,
  };
}

function quarantineFromError(
  kind: 'SENTENCE' | 'LINK',
  sourceId: string | null,
  error: TatoebaImportError,
): TatoebaQuarantineEntry {
  return { kind, sourceId, relatedSourceId: null, reason: error.code, details: error.details };
}

export async function runTatoebaDryRun(options: TatoebaDryRunOptions): Promise<TatoebaDryRunReport> {
  const bounds = assertRunBounds(options);
  const now = options.now ?? (() => new Date().toISOString());
  const retrievedAt = now();
  const artifacts = [];
  artifacts.push(await hashTatoebaArtifact('sentences_detailed', options.sentencesDetailedPath));
  artifacts.push(await hashTatoebaArtifact('sentences_cc0', options.sentencesCc0Path));
  artifacts.push(await hashTatoebaArtifact('links', options.linksPath));
  const snapshot: TatoebaSnapshotMetadata = {
    snapshotId: deterministicSnapshotId(artifacts),
    retrievedAt,
    artifacts,
  };
  const importBatch = `tatoeba-08d3a-${snapshot.snapshotId.slice(-24)}`;
  const counts = emptyCounts();
  const quarantine: TatoebaQuarantineEntry[] = [];
  let quarantineOverflow = false;
  const recordQuarantine = (entry: TatoebaQuarantineEntry): void => {
    if (quarantine.length >= TATOEBA_MAX_REPORT_ROWS) quarantineOverflow = true;
    addQuarantine(quarantine, entry);
  };

  const selectedRows = new Map<string, TatoebaBulkSentenceRow>();
  const duplicateBlocked = new Set<string>();
  for await (const row of readDetailedSentenceRows(options.sentencesDetailedPath, {
    maxRows: options.sentenceLimit,
    onMalformed: (error) => {
      counts.sentencesDiscovered += 1;
      counts.malformedRows += 1;
      recordQuarantine(quarantineFromError('SENTENCE', null, error));
      counts.quarantinedSentences += 1;
    },
  })) {
    counts.sentencesDiscovered += 1;
    counts.sentencesParsed += 1;
    const projectLanguage = mapTatoebaLanguage(row.tatoebaLanguage);
    if (!projectLanguage) {
      counts.unsupportedLanguage += 1;
      recordQuarantine({
        kind: 'SENTENCE',
        sourceId: row.sentenceId,
        relatedSourceId: null,
        reason: 'TATOEBA_UNSUPPORTED_LANGUAGE',
        details: { language: row.tatoebaLanguage },
      });
      counts.quarantinedSentences += 1;
      continue;
    }
    if (!options.languages.includes(projectLanguage)) continue;
    const existing = selectedRows.get(row.sentenceId);
    if (existing || duplicateBlocked.has(row.sentenceId)) {
      counts.duplicateSentences += 1;
      if (existing && (existing.text !== row.text || existing.tatoebaLanguage !== row.tatoebaLanguage || existing.username !== row.username)) {
        duplicateBlocked.add(row.sentenceId);
        selectedRows.delete(row.sentenceId);
        recordQuarantine({
          kind: 'SENTENCE',
          sourceId: row.sentenceId,
          relatedSourceId: null,
          reason: 'TATOEBA_DUPLICATE_SENTENCE_CONFLICT',
          details: {},
        });
        counts.quarantinedSentences += 1;
      }
      continue;
    }
    selectedRows.set(row.sentenceId, row);
  }

  const cc0SentenceIds = new Set<string>();
  const snapshotMismatchIds = new Set<string>();
  let cc0SnapshotUnsafe = false;
  let cc0RowsScanned = 0;
  for await (const row of readCc0SentenceRows(options.sentencesCc0Path, {
    maxRows: TATOEBA_MAX_CC0_SCAN_ROWS + 1,
    onMalformed: (error) => {
      cc0RowsScanned += 1;
      cc0SnapshotUnsafe = true;
      if (cc0RowsScanned > TATOEBA_MAX_CC0_SCAN_ROWS) {
        throw tatoebaError('TATOEBA_INPUT_LIMIT_EXCEEDED', 'CC0 snapshot scan exceeded the bounded integrity limit.');
      }
      counts.malformedRows += 1;
      recordQuarantine(quarantineFromError('SENTENCE', null, error));
    },
  })) {
    cc0RowsScanned += 1;
    if (cc0RowsScanned > TATOEBA_MAX_CC0_SCAN_ROWS) {
      throw tatoebaError('TATOEBA_INPUT_LIMIT_EXCEEDED', 'CC0 snapshot scan exceeded the bounded integrity limit.');
    }
    const selected = selectedRows.get(row.sentenceId);
    if (!selected) continue;
    cc0SentenceIds.add(row.sentenceId);
    if (selected.text !== row.text) {
      snapshotMismatchIds.add(row.sentenceId);
      recordQuarantine({
        kind: 'SENTENCE',
        sourceId: row.sentenceId,
        relatedSourceId: null,
        reason: 'TATOEBA_CC0_MISMATCH',
        details: { mismatch: 'cc0_snapshot_text' },
      });
    }
    if (selected.tatoebaLanguage !== row.tatoebaLanguage) {
      snapshotMismatchIds.add(row.sentenceId);
      recordQuarantine({
        kind: 'SENTENCE',
        sourceId: row.sentenceId,
        relatedSourceId: null,
        reason: 'TATOEBA_LANGUAGE_MISMATCH',
        details: { mismatch: 'cc0_snapshot_language' },
      });
    }
  }
  if (cc0SnapshotUnsafe) {
    for (const sentenceId of selectedRows.keys()) {
      snapshotMismatchIds.add(sentenceId);
      recordQuarantine({
        kind: 'SENTENCE',
        sourceId: sentenceId,
        relatedSourceId: null,
        reason: 'TATOEBA_MALFORMED_BULK_ROW',
        details: { artifact: 'sentences_CC0' },
      });
    }
  }
  counts.quarantinedSentences += snapshotMismatchIds.size;

  const apiClient = options.apiClient ?? new TatoebaSentenceApiClient({
    timeoutMs: bounds.apiTimeoutMs,
    retries: bounds.apiRetries,
    maxResponseBytes: bounds.apiMaxResponseBytes,
    now,
  });
  const selected = [...selectedRows.values()].sort((left, right) => compareSentenceIds(left.sentenceId, right.sentenceId));
  const outcomes = await mapWithConcurrency(selected, bounds.apiConcurrency, async (row): Promise<ApiOutcome> => {
    try {
      return { row, result: await apiClient.getSentence(row.sentenceId) };
    } catch (error) {
      if (error instanceof TatoebaImportError) return { row, error };
      return { row, error: new TatoebaImportError('TATOEBA_API_UNAVAILABLE', 'Tatoeba API request failed.') };
    }
  });

  const eligible = new Map<string, TatoebaValidatedSentenceCandidate>();
  for (const outcome of outcomes) {
    counts.apiChecked += 1;
    if (outcome.error) {
      sentenceErrorCount(counts, outcome.error.code);
      recordQuarantine(quarantineFromError('SENTENCE', outcome.row.sentenceId, outcome.error));
      counts.quarantinedSentences += 1;
      continue;
    }
    if (!outcome.result) {
      const error = new TatoebaImportError('TATOEBA_API_UNAVAILABLE', 'Tatoeba API returned no sentence result.');
      sentenceErrorCount(counts, error.code);
      recordQuarantine(quarantineFromError('SENTENCE', outcome.row.sentenceId, error));
      counts.quarantinedSentences += 1;
      continue;
    }
    const license = outcome.result.facts.license;
    if (license === 'CC BY 2.0 FR') counts.licenseCcBy += 1;
    if (license === 'CC0 1.0') counts.licenseCc0 += 1;
    if (snapshotMismatchIds.has(outcome.row.sentenceId)) {
      continue;
    }
    const validation = validateTatoebaSentenceCandidate({
      bulk: outcome.row,
      api: outcome.result,
      cc0SentenceIds,
      snapshot,
      importBatch,
    });
    if (!validation.ok) {
      sentenceErrorCount(counts, validation.reason);
      recordQuarantine({
        kind: 'SENTENCE',
        sourceId: outcome.row.sentenceId,
        relatedSourceId: null,
        reason: validation.reason,
        details: validation.details,
      });
      counts.quarantinedSentences += 1;
      continue;
    }
    eligible.set(validation.candidate.sentenceId, validation.candidate);
  }
  counts.sentencesEligible = eligible.size;

  const links = [];
  for await (const row of readLinkRows(options.linksPath, {
    maxRows: options.linkLimit,
    onMalformed: (error) => {
      counts.linksDiscovered += 1;
      counts.malformedRows += 1;
      recordQuarantine(quarantineFromError('LINK', null, error));
    },
  })) {
    counts.linksDiscovered += 1;
    counts.linksParsed += 1;
    links.push(row);
  }
  const translationResult = buildTatoebaTranslationCandidates({
    links,
    eligibleSentences: eligible,
    directions: options.directions,
  });
  counts.reciprocalPairsCollapsed = translationResult.counts.reciprocalPairsCollapsed;
  counts.missingLinkEndpoints = translationResult.counts.missingLinkEndpoints;
  counts.sameLanguageLinks = translationResult.counts.sameLanguageLinks;
  counts.ambiguousLanguageLinks = translationResult.counts.ambiguousLanguageLinks;
  counts.duplicateInputPairs = translationResult.counts.duplicateInputPairs;
  counts.translationCandidates = translationResult.counts.translationCandidates;
  counts.directionConflicts = translationResult.counts.directionConflicts;
  for (const entry of translationResult.quarantine) recordQuarantine(entry);
  counts.wouldCreateSentences = eligible.size;
  counts.wouldCreateTranslations = translationResult.candidates.length;

  const report: TatoebaDryRunReport = {
    reportVersion: 1,
    mode: 'DRY_RUN',
    dbPreflight: 'SKIPPED_08D3A',
    snapshot,
    configuration: {
      languages: [...options.languages],
      directions: [...options.directions],
      sentenceLimit: options.sentenceLimit,
      linkLimit: options.linkLimit,
      apiConcurrency: bounds.apiConcurrency,
      apiTimeoutMs: bounds.apiTimeoutMs,
      apiRetries: bounds.apiRetries,
      apiMaxResponseBytes: bounds.apiMaxResponseBytes,
    },
    counts,
    candidates: {
      sentences: [...eligible.values()].sort((left, right) => compareSentenceIds(left.sentenceId, right.sentenceId)),
      translations: translationResult.candidates,
    },
    quarantine,
    quarantineTruncated: quarantineOverflow,
  };
  return report;
}

export async function writeTatoebaDryRunReport(report: TatoebaDryRunReport, reportPath: string): Promise<void> {
  const extension = extname(reportPath).toLowerCase();
  const output = extension === '.jsonl'
    ? [
        JSON.stringify({ type: 'summary', reportVersion: report.reportVersion, mode: report.mode, dbPreflight: report.dbPreflight, snapshot: report.snapshot, configuration: report.configuration, counts: report.counts, quarantineTruncated: report.quarantineTruncated }),
        ...report.candidates.sentences.map((candidate) => JSON.stringify({ type: 'sentence-candidate', candidate })),
        ...report.candidates.translations.map((candidate) => JSON.stringify({ type: 'translation-candidate', candidate })),
        ...report.quarantine.map((entry) => JSON.stringify({ type: 'quarantine', entry })),
      ].join('\n') + '\n'
    : JSON.stringify(report, null, 2) + '\n';
  try {
    await fs.writeFile(reportPath, output, 'utf8');
  } catch (error) {
    throw new TatoebaImportError('TATOEBA_REPORT_WRITE_FAILED', 'Tatoeba dry-run report could not be written.');
  }
}
