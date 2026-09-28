import { buildTatoebaAttribution, sentenceSourceUrl } from './tatoeba.attribution';
import { canonicalSentenceId, sentenceSourceIdentity } from './tatoeba.identities';
import { isProjectLanguage } from './tatoeba.languages';
import { validateSnapshotRetrievedAt } from './tatoeba.timestamps';
import { validateTatoebaLibraryText } from './tatoeba.text';
import type { TatoebaLibraryLicenseKey } from './tatoeba-preflight.types';
import {
  TATOEBA_SENTENCE_IMPORT_LOCK_PREFIX,
  type TatoebaSentenceImportQuarantineReason,
} from './tatoeba-sentence-import.types';
import type { TatoebaLicense, TatoebaValidatedSentenceCandidate } from './tatoeba.types';

export const TATOEBA_LIBRARY_LICENSE_KEY_BY_API_LICENSE: Record<TatoebaLicense, TatoebaLibraryLicenseKey> = {
  'CC BY 2.0 FR': 'CC_BY_2_0_FR',
  'CC0 1.0': 'CC0_1_0',
};

export function safeTatoebaSentenceSourceIdentity(value: unknown): string | null {
  return typeof value === 'string' && /^TATOEBA:SENTENCE:[1-9][0-9]{0,39}$/u.test(value)
    ? value
    : null;
}

export type TatoebaSentenceImportCandidateValidation =
  | {
    ok: true;
    libraryLicenseKey: TatoebaLibraryLicenseKey;
    sourceIdentity: string;
    lockIdentity: string;
  }
  | {
    ok: false;
    reason: TatoebaSentenceImportQuarantineReason;
    details: Record<string, string | number | boolean | null>;
  };

function invalid(
  reason: TatoebaSentenceImportQuarantineReason,
  details: Record<string, string | number | boolean | null> = {},
): TatoebaSentenceImportCandidateValidation {
  return { ok: false, reason, details };
}

function isNonBlankBounded(value: string, maxLength: number): boolean {
  return value.length >= 1 && value.length <= maxLength && value.trim().length > 0;
}

export function validateTatoebaSentenceImportCandidate(
  candidate: TatoebaValidatedSentenceCandidate,
): TatoebaSentenceImportCandidateValidation {
  if (candidate.provider !== 'TATOEBA') return invalid('TATOEBA_IMPORT_CANDIDATE_INVALID');

  let sentenceId: string;
  try {
    sentenceId = canonicalSentenceId(candidate.sentenceId);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'TATOEBA_INVALID_ID') {
      return invalid('TATOEBA_INVALID_ID');
    }
    return invalid('TATOEBA_IMPORT_CANDIDATE_INVALID');
  }

  const expectedSourceIdentity = sentenceSourceIdentity(sentenceId);
  if (candidate.sourceIdentity !== expectedSourceIdentity) {
    return invalid('TATOEBA_IMPORT_CANDIDATE_INVALID', { field: 'sourceIdentity' });
  }
  if (candidate.sourceUrl !== sentenceSourceUrl(sentenceId)) {
    return invalid('TATOEBA_IMPORT_CANDIDATE_INVALID', { field: 'sourceUrl' });
  }
  if (!isProjectLanguage(candidate.projectLanguage)) {
    return invalid('TATOEBA_UNSUPPORTED_LANGUAGE', { language: candidate.projectLanguage });
  }

  const textEligibility = validateTatoebaLibraryText(candidate.text);
  if (!textEligibility.ok) {
    return invalid(textEligibility.reason, { characterLength: textEligibility.characterLength });
  }

  const libraryLicenseKey = TATOEBA_LIBRARY_LICENSE_KEY_BY_API_LICENSE[candidate.license];
  if (!libraryLicenseKey) return invalid('TATOEBA_LICENSE_UNKNOWN');
  if (candidate.license === 'CC BY 2.0 FR' && (!candidate.owner || candidate.owner.trim().length === 0)) {
    return invalid('TATOEBA_OWNER_REQUIRED');
  }
  if (!isNonBlankBounded(candidate.importBatch, 120)) {
    return invalid('TATOEBA_IMPORT_CANDIDATE_INVALID', { field: 'importBatch' });
  }
  if (!isNonBlankBounded(candidate.snapshotId, 255)) {
    return invalid('TATOEBA_IMPORT_CANDIDATE_INVALID', { field: 'snapshotId' });
  }

  try {
    validateSnapshotRetrievedAt(candidate.apiCheckedAt);
    const expectedAttribution = buildTatoebaAttribution({
      sentenceId,
      sourceUrl: candidate.sourceUrl,
      license: candidate.license,
      owner: candidate.owner,
      transformationNote: candidate.transformationNote,
    });
    if (candidate.attribution !== expectedAttribution) {
      return invalid('TATOEBA_IMPORT_CANDIDATE_INVALID', { field: 'attribution' });
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
      return invalid(error.code as TatoebaSentenceImportQuarantineReason);
    }
    return invalid('TATOEBA_IMPORT_CANDIDATE_INVALID');
  }

  return {
    ok: true,
    libraryLicenseKey,
    sourceIdentity: expectedSourceIdentity,
    lockIdentity: `${TATOEBA_SENTENCE_IMPORT_LOCK_PREFIX}${sentenceId}`,
  };
}
