import { buildTatoebaAttribution, sentenceSourceUrl } from './tatoeba.attribution';
import { directTranslationIdentity, inputPairIdentity, canonicalSentenceId, translationLockIdentity, translationProvenanceSourceId } from './tatoeba.identities';
import { isProjectLanguage } from './tatoeba.languages';
import { validateSnapshotRetrievedAt } from './tatoeba.timestamps';
import { TATOEBA_MAX_IMPORT_BATCH_LENGTH } from './tatoeba.constants';
import { validateTatoebaLibraryText } from './tatoeba.text';
import type { TatoebaLibraryLicenseKey } from './tatoeba-preflight.types';
import type { TatoebaLicense, TatoebaProjectLanguage, TatoebaProvenancePreview, TatoebaTranslationCandidate } from './tatoeba.types';
import type { TatoebaTranslationImportQuarantineReason } from './tatoeba-translation-import.types';

export const TATOEBA_LIBRARY_LICENSE_KEY_BY_API_LICENSE: Record<TatoebaLicense, TatoebaLibraryLicenseKey> = {
  'CC BY 2.0 FR': 'CC_BY_2_0_FR',
  'CC0 1.0': 'CC0_1_0',
};

export function safeTatoebaTranslationIdentity(value: unknown): string | null {
  return typeof value === 'string'
    && /^TATOEBA:LINK:DIRECT:[1-9][0-9]{0,39}:[1-9][0-9]{0,39}$/u.test(value)
    ? value
    : null;
}

export function safeTatoebaInputPairIdentity(value: unknown): string | null {
  return typeof value === 'string'
    && /^TATOEBA:PAIR:[1-9][0-9]{0,39}:[1-9][0-9]{0,39}$/u.test(value)
    ? value
    : null;
}

export type TatoebaTranslationImportCandidateValidation =
  | {
    ok: true;
    durableIdentity: string;
    inputPairIdentity: string;
    sourceIdentity: string;
    targetIdentity: string;
    lockIdentity: string;
    sourceLicenseKey: TatoebaLibraryLicenseKey;
    targetLicenseKey: TatoebaLibraryLicenseKey;
  }
  | {
    ok: false;
    reason: TatoebaTranslationImportQuarantineReason;
    details: Record<string, string | number | boolean | null>;
  };

function invalid(
  reason: TatoebaTranslationImportQuarantineReason,
  details: Record<string, string | number | boolean | null> = {},
): TatoebaTranslationImportCandidateValidation {
  return { ok: false, reason, details };
}

function boundedNonBlank(value: string, maxLength: number): boolean {
  return value.length >= 1 && value.length <= maxLength && value.trim().length > 0;
}

function canonicalId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return canonicalSentenceId(value);
  } catch {
    return null;
  }
}

function validEndpointProvenance(
  provenance: TatoebaProvenancePreview,
  role: 'SOURCE' | 'TARGET',
  sentenceId: string,
  candidate: TatoebaTranslationCandidate,
): TatoebaTranslationImportCandidateValidation | null {
  if (!provenance || typeof provenance !== 'object') {
    return invalid('TATOEBA_TRANSLATION_CANDIDATE_INVALID', { field: `${role.toLowerCase()}Provenance` });
  }
  if (provenance.endpointRole !== role || provenance.endpointSentenceId !== sentenceId) {
    return invalid('TATOEBA_TRANSLATION_CANDIDATE_INVALID', { field: `${role.toLowerCase()}Provenance.endpoint` });
  }
  if (provenance.sourceId !== translationProvenanceSourceId(candidate.sourceSentenceId, candidate.targetSentenceId, role)) {
    return invalid('TATOEBA_TRANSLATION_CANDIDATE_INVALID', { field: `${role.toLowerCase()}Provenance.sourceId` });
  }
  if (provenance.sourceUrl !== sentenceSourceUrl(sentenceId)) {
    return invalid('TATOEBA_TRANSLATION_CANDIDATE_INVALID', { field: `${role.toLowerCase()}Provenance.sourceUrl` });
  }
  if (provenance.relationIdentity !== candidate.durableIdentity || provenance.inputPairIdentity !== candidate.inputPairIdentity) {
    return invalid('TATOEBA_TRANSLATION_CANDIDATE_INVALID', { field: `${role.toLowerCase()}Provenance.relationIdentity` });
  }
  if (
    provenance.primaryLanguageCode !== candidate.primaryLanguageCode
    || provenance.secondaryLanguageCode !== candidate.secondaryLanguageCode
  ) {
    return invalid('TATOEBA_DIRECTION_INVALID', { field: `${role.toLowerCase()}Provenance.direction` });
  }
  if (!boundedNonBlank(provenance.importBatch, TATOEBA_MAX_IMPORT_BATCH_LENGTH)) {
    return invalid('TATOEBA_TRANSLATION_CANDIDATE_INVALID', { field: `${role.toLowerCase()}Provenance.importBatch` });
  }
  if (!boundedNonBlank(provenance.snapshotId, 255)) {
    return invalid('TATOEBA_TRANSLATION_CANDIDATE_INVALID', { field: `${role.toLowerCase()}Provenance.snapshotId` });
  }
  try {
    validateSnapshotRetrievedAt(provenance.apiCheckedAt);
  } catch {
    return invalid('TATOEBA_TRANSLATION_CANDIDATE_INVALID', { field: `${role.toLowerCase()}Provenance.apiCheckedAt` });
  }
  if (provenance.transformationNote !== null) {
    return invalid('TATOEBA_TRANSLATION_CANDIDATE_INVALID', { field: `${role.toLowerCase()}Provenance.transformationNote` });
  }
  if (provenance.license !== 'CC BY 2.0 FR' && provenance.license !== 'CC0 1.0') {
    return invalid('TATOEBA_LICENSE_UNKNOWN', { endpoint: role });
  }
  if (provenance.license === 'CC BY 2.0 FR' && (!provenance.owner || provenance.owner.trim().length === 0)) {
    return invalid('TATOEBA_OWNER_REQUIRED', { endpoint: role });
  }
  if (provenance.owner !== null && (!boundedNonBlank(provenance.owner, 255))) {
    return invalid('TATOEBA_TRANSLATION_CANDIDATE_INVALID', { field: `${role.toLowerCase()}Provenance.owner` });
  }
  try {
    const expectedAttribution = buildTatoebaAttribution({
      sentenceId,
      sourceUrl: provenance.sourceUrl,
      license: provenance.license,
      owner: provenance.owner,
      transformationNote: null,
    });
    if (provenance.attribution !== expectedAttribution) {
      return invalid('TATOEBA_TRANSLATION_CANDIDATE_INVALID', { field: `${role.toLowerCase()}Provenance.attribution` });
    }
  } catch {
    return invalid('TATOEBA_TRANSLATION_CANDIDATE_INVALID', { field: `${role.toLowerCase()}Provenance.attribution` });
  }
  return null;
}

export function validateTatoebaTranslationImportCandidate(
  candidate: TatoebaTranslationCandidate,
): TatoebaTranslationImportCandidateValidation {
  if (!candidate || typeof candidate !== 'object') return invalid('TATOEBA_TRANSLATION_CANDIDATE_INVALID');
  if (candidate.provider !== 'TATOEBA') return invalid('TATOEBA_TRANSLATION_CANDIDATE_INVALID');

  const sourceId = canonicalId(candidate.sourceSentenceId);
  const targetId = canonicalId(candidate.targetSentenceId);
  if (!sourceId || !targetId || sourceId === targetId) {
    return invalid('TATOEBA_TRANSLATION_CANDIDATE_INVALID', { field: 'sentenceId' });
  }
  if (!isProjectLanguage(candidate.primaryLanguageCode) || !isProjectLanguage(candidate.secondaryLanguageCode)) {
    return invalid('TATOEBA_UNSUPPORTED_LANGUAGE');
  }
  if (candidate.primaryLanguageCode === candidate.secondaryLanguageCode) {
    return invalid('TATOEBA_DIRECTION_INVALID');
  }

  const expectedPairIdentity = inputPairIdentity(sourceId, targetId);
  const expectedDurableIdentity = directTranslationIdentity(sourceId, targetId);
  if (candidate.inputPairIdentity !== expectedPairIdentity || candidate.durableIdentity !== expectedDurableIdentity) {
    return invalid('TATOEBA_TRANSLATION_CANDIDATE_INVALID', { field: 'identity' });
  }

  const sourceText = validateTatoebaLibraryText(candidate.sourceText);
  if (!sourceText.ok) return invalid(sourceText.reason, { endpoint: 'SOURCE', characterLength: sourceText.characterLength });
  const targetText = validateTatoebaLibraryText(candidate.translatedText);
  if (!targetText.ok) return invalid(targetText.reason, { endpoint: 'TARGET', characterLength: targetText.characterLength });

  const sourceProvenanceValidation = validEndpointProvenance(
    candidate.sourceProvenance,
    'SOURCE',
    sourceId,
    candidate,
  );
  if (sourceProvenanceValidation) return sourceProvenanceValidation;
  const targetProvenanceValidation = validEndpointProvenance(
    candidate.targetProvenance,
    'TARGET',
    targetId,
    candidate,
  );
  if (targetProvenanceValidation) return targetProvenanceValidation;

  if (
    candidate.sourceProvenance.importBatch !== candidate.targetProvenance.importBatch
    || candidate.sourceProvenance.snapshotId !== candidate.targetProvenance.snapshotId
  ) {
    return invalid('TATOEBA_TRANSLATION_CANDIDATE_INVALID', { field: 'snapshotConsistency' });
  }

  const sourceLicenseKey = TATOEBA_LIBRARY_LICENSE_KEY_BY_API_LICENSE[candidate.sourceProvenance.license];
  const targetLicenseKey = TATOEBA_LIBRARY_LICENSE_KEY_BY_API_LICENSE[candidate.targetProvenance.license];
  if (!sourceLicenseKey || !targetLicenseKey) return invalid('TATOEBA_LICENSE_UNKNOWN');

  return {
    ok: true,
    durableIdentity: expectedDurableIdentity,
    inputPairIdentity: expectedPairIdentity,
    sourceIdentity: `TATOEBA:SENTENCE:${sourceId}`,
    targetIdentity: `TATOEBA:SENTENCE:${targetId}`,
    lockIdentity: translationLockIdentity(sourceId, targetId),
    sourceLicenseKey,
    targetLicenseKey,
  };
}
