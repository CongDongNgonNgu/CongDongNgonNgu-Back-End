import { describe, expect, it } from '@jest/globals';

import { buildTatoebaAttribution, sentenceSourceUrl } from './tatoeba.attribution';
import {
  TATOEBA_LIBRARY_LICENSE_KEY_BY_API_LICENSE,
  validateTatoebaTranslationImportCandidate,
} from './tatoeba-translation-import.contract';
import { directTranslationIdentity, inputPairIdentity, translationProvenanceSourceId } from './tatoeba.identities';
import type { TatoebaTranslationCandidate } from './tatoeba.types';

const sourceId = '100';
const targetId = '200';
const durableIdentity = directTranslationIdentity(sourceId, targetId);
const pairIdentity = inputPairIdentity(sourceId, targetId);

function endpoint(
  sentenceId: string,
  role: 'SOURCE' | 'TARGET',
  license: 'CC BY 2.0 FR' | 'CC0 1.0',
  owner: string | null,
  language: 'vi' | 'en',
) {
  const sourceUrl = sentenceSourceUrl(sentenceId);
  return {
    sourceId: translationProvenanceSourceId(sourceId, targetId, role),
    sourceUrl,
    license,
    owner,
    attribution: buildTatoebaAttribution({
      sentenceId,
      sourceUrl,
      license,
      owner,
      transformationNote: null,
    }),
    endpointSentenceId: sentenceId,
    endpointRole: role,
    relationIdentity: durableIdentity,
    inputPairIdentity: pairIdentity,
    primaryLanguageCode: 'vi' as const,
    secondaryLanguageCode: 'en' as const,
    importBatch: 'tatoeba-08d3c-test',
    snapshotId: 'TATOEBA-SNAPSHOT-test',
    apiCheckedAt: '2026-09-28T00:00:01.000Z',
    transformationNote: null,
  };
}

function candidate(): TatoebaTranslationCandidate {
  return {
    provider: 'TATOEBA',
    inputPairIdentity: pairIdentity,
    durableIdentity,
    primaryLanguageCode: 'vi',
    secondaryLanguageCode: 'en',
    sourceSentenceId: sourceId,
    targetSentenceId: targetId,
    sourceText: '  Xin chào  ',
    translatedText: '  Hello  ',
    sourceProvenance: endpoint(sourceId, 'SOURCE', 'CC BY 2.0 FR', 'alice', 'vi'),
    targetProvenance: endpoint(targetId, 'TARGET', 'CC0 1.0', null, 'en'),
  };
}

describe('Tatoeba translation import candidate contract', () => {
  it('accepts one directed, direct translation with independent endpoint licenses', () => {
    const result = validateTatoebaTranslationImportCandidate(candidate());

    expect(result).toMatchObject({
      ok: true,
      durableIdentity,
      inputPairIdentity: pairIdentity,
      sourceLicenseKey: 'CC_BY_2_0_FR',
      targetLicenseKey: 'CC0_1_0',
    });
    expect(TATOEBA_LIBRARY_LICENSE_KEY_BY_API_LICENSE['CC0 1.0']).toBe('CC0_1_0');
  });

  it('rejects an unordered identity or endpoint role mismatch', () => {
    const unordered = candidate();
    unordered.durableIdentity = 'TATOEBA:LINK:DIRECT:200:100';
    expect(validateTatoebaTranslationImportCandidate(unordered)).toMatchObject({
      ok: false,
      reason: 'TATOEBA_TRANSLATION_CANDIDATE_INVALID',
    });

    const wrongRole = candidate();
    wrongRole.targetProvenance.endpointRole = 'SOURCE';
    expect(validateTatoebaTranslationImportCandidate(wrongRole)).toMatchObject({
      ok: false,
      reason: 'TATOEBA_TRANSLATION_CANDIDATE_INVALID',
    });
  });

  it('rejects indirect, self-referential, unsupported, and unsafe endpoint input', () => {
    const selfReference = candidate();
    selfReference.targetSentenceId = sourceId;
    expect(validateTatoebaTranslationImportCandidate(selfReference)).toMatchObject({
      ok: false,
      reason: 'TATOEBA_TRANSLATION_CANDIDATE_INVALID',
    });

    const tooLong = candidate();
    tooLong.sourceText = 'x'.repeat(20_001);
    expect(validateTatoebaTranslationImportCandidate(tooLong)).toMatchObject({
      ok: false,
      reason: 'TATOEBA_TEXT_TOO_LONG',
    });

    const blank = candidate();
    blank.translatedText = '   ';
    expect(validateTatoebaTranslationImportCandidate(blank)).toMatchObject({
      ok: false,
      reason: 'TATOEBA_EMPTY_TEXT',
    });

    const missingOwner = candidate();
    missingOwner.sourceProvenance.owner = null;
    expect(validateTatoebaTranslationImportCandidate(missingOwner)).toMatchObject({
      ok: false,
      reason: 'TATOEBA_OWNER_REQUIRED',
    });
  });

  it('does not normalize source or translated text', () => {
    const value = candidate();
    const result = validateTatoebaTranslationImportCandidate(value);
    expect(result.ok).toBe(true);
    expect(value.sourceText).toBe('  Xin chào  ');
    expect(value.translatedText).toBe('  Hello  ');
  });
});
