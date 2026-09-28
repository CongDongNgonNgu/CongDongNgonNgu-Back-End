import { TATOEBA_SUPPORTED_LICENSES } from './tatoeba.constants';
import { buildTatoebaAttribution, sentenceSourceUrl } from './tatoeba.attribution';
import { TatoebaImportError } from './tatoeba.errors';
import { mapTatoebaLanguage, isProjectLanguage } from './tatoeba.languages';
import { sentenceSourceIdentity } from './tatoeba.identities';
import type {
  TatoebaApiSentenceCheck,
  TatoebaBulkSentenceRow,
  TatoebaLicense,
  TatoebaValidatedSentenceCandidate,
} from './tatoeba.types';

export interface TatoebaSentenceValidationInput {
  bulk: TatoebaBulkSentenceRow;
  api: TatoebaApiSentenceCheck;
  cc0SentenceIds: ReadonlySet<string>;
  snapshot: { snapshotId: string };
  importBatch: string;
}

export type TatoebaSentenceValidationResult =
  | { ok: true; candidate: TatoebaValidatedSentenceCandidate }
  | {
      ok: false;
      reason: string;
      details: Record<string, string | number | boolean | null>;
    };

function rejected(error: TatoebaImportError): TatoebaSentenceValidationResult {
  return { ok: false, reason: error.code, details: error.details };
}

function acceptedLicense(value: string | null): value is TatoebaLicense {
  return TATOEBA_SUPPORTED_LICENSES.includes(value as (typeof TATOEBA_SUPPORTED_LICENSES)[number]);
}

export function validateTatoebaSentenceCandidate(
  input: TatoebaSentenceValidationInput,
): TatoebaSentenceValidationResult {
  const bulkLanguage = mapTatoebaLanguage(input.bulk.tatoebaLanguage);
  if (!bulkLanguage) {
    return { ok: false, reason: 'TATOEBA_UNSUPPORTED_LANGUAGE', details: { bulkLanguage: input.bulk.tatoebaLanguage } };
  }
  const apiLanguage = mapTatoebaLanguage(input.api.facts.tatoebaLanguage);
  if (!apiLanguage) {
    return { ok: false, reason: 'TATOEBA_UNSUPPORTED_LANGUAGE', details: { apiLanguage: input.api.facts.tatoebaLanguage } };
  }
  if (!isProjectLanguage(bulkLanguage) || !isProjectLanguage(apiLanguage) || bulkLanguage !== apiLanguage) {
    return {
      ok: false,
      reason: 'TATOEBA_LANGUAGE_MISMATCH',
      details: { bulkLanguage, apiLanguage },
    };
  }
  if (input.bulk.text.length === 0 || input.api.facts.text.length === 0) {
    return { ok: false, reason: 'TATOEBA_EMPTY_TEXT', details: {} };
  }
  if (input.bulk.text !== input.api.facts.text) {
    return { ok: false, reason: 'TATOEBA_TEXT_MISMATCH', details: {} };
  }
  if (!acceptedLicense(input.api.facts.license)) {
    return { ok: false, reason: input.api.facts.license === 'PROBLEM' ? 'TATOEBA_LICENSE_PROBLEM' : 'TATOEBA_LICENSE_UNKNOWN', details: {} };
  }
  if (input.api.facts.isUnapproved) {
    return { ok: false, reason: 'TATOEBA_UNAPPROVED', details: {} };
  }
  if (input.api.facts.license === 'CC BY 2.0 FR') {
    if (input.bulk.username === null && input.api.facts.owner === null) {
      return { ok: false, reason: 'TATOEBA_OWNER_REQUIRED', details: {} };
    }
    if (input.bulk.username === null || input.api.facts.owner === null || input.bulk.username !== input.api.facts.owner) {
      return {
        ok: false,
        reason: 'TATOEBA_OWNER_MISMATCH',
        details: { bulkOwner: input.bulk.username, apiOwner: input.api.facts.owner },
      };
    }
  } else if (
    input.bulk.username !== null &&
    input.api.facts.owner !== null &&
    input.bulk.username !== input.api.facts.owner
  ) {
    return {
      ok: false,
      reason: 'TATOEBA_OWNER_MISMATCH',
      details: { bulkOwner: input.bulk.username, apiOwner: input.api.facts.owner },
    };
  }
  const cc0Snapshot = input.cc0SentenceIds.has(input.bulk.sentenceId);
  if (cc0Snapshot !== (input.api.facts.license === 'CC0 1.0')) {
    return {
      ok: false,
      reason: 'TATOEBA_CC0_MISMATCH',
      details: { cc0Snapshot, apiLicense: input.api.facts.license },
    };
  }

  try {
    const sourceUrl = sentenceSourceUrl(input.bulk.sentenceId);
    return {
      ok: true,
      candidate: {
        provider: 'TATOEBA',
        sentenceId: input.bulk.sentenceId,
        projectLanguage: bulkLanguage,
        text: input.bulk.text,
        license: input.api.facts.license,
        owner: input.api.facts.owner,
        sourceUrl,
        sourceIdentity: sentenceSourceIdentity(input.bulk.sentenceId),
        attribution: buildTatoebaAttribution({
          sentenceId: input.bulk.sentenceId,
          sourceUrl,
          license: input.api.facts.license,
          owner: input.api.facts.owner,
          transformationNote: null,
        }),
        importBatch: input.importBatch,
        snapshotId: input.snapshot.snapshotId,
        apiCheckedAt: input.api.checkedAt,
        transformationNote: null,
      },
    };
  } catch (error) {
    if (error instanceof TatoebaImportError) return rejected(error);
    throw error;
  }
}
