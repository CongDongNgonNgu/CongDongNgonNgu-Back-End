import { describe, expect, it } from '@jest/globals';

import { buildTatoebaAttribution, sentenceSourceUrl } from './tatoeba.attribution';
import { validateTatoebaSentenceImportCandidate } from './tatoeba-sentence-import.contract';
import type { TatoebaValidatedSentenceCandidate } from './tatoeba.types';

const VALID_CANDIDATE: TatoebaValidatedSentenceCandidate = {
  provider: 'TATOEBA',
  sentenceId: '123',
  projectLanguage: 'vi',
  text: 'Xin chào',
  license: 'CC BY 2.0 FR',
  owner: 'alice',
  sourceUrl: sentenceSourceUrl('123'),
  sourceIdentity: 'TATOEBA:SENTENCE:123',
  attribution: buildTatoebaAttribution({
    sentenceId: '123',
    sourceUrl: sentenceSourceUrl('123'),
    license: 'CC BY 2.0 FR',
    owner: 'alice',
    transformationNote: null,
  }),
  importBatch: 'tatoeba-08d3a-test',
  snapshotId: 'TATOEBA-SNAPSHOT-test',
  apiCheckedAt: '2026-09-28T00:00:01.000Z',
  transformationNote: null,
};

describe('Tatoeba sentence import contract', () => {
  it('accepts a validated candidate and derives the Library license key and lock identity', () => {
    expect(validateTatoebaSentenceImportCandidate(VALID_CANDIDATE)).toEqual({
      ok: true,
      libraryLicenseKey: 'CC_BY_2_0_FR',
      sourceIdentity: 'TATOEBA:SENTENCE:123',
      lockIdentity: 'OPEN_DATASET:TATOEBA:SENTENCE:123',
    });
  });

  it.each([
    ['provider', { provider: 'OTHER' }, 'TATOEBA_IMPORT_CANDIDATE_INVALID'],
    ['source identity', { sourceIdentity: 'TATOEBA:SENTENCE:999' }, 'TATOEBA_IMPORT_CANDIDATE_INVALID'],
    ['source URL', { sourceUrl: 'https://example.test/sentence/123' }, 'TATOEBA_IMPORT_CANDIDATE_INVALID'],
    ['blank text', { text: '   ' }, 'TATOEBA_EMPTY_TEXT'],
    ['over-limit text', { text: 'x'.repeat(20_001) }, 'TATOEBA_TEXT_TOO_LONG'],
    ['missing CC BY owner', { owner: null, attribution: 'not-safe' }, 'TATOEBA_OWNER_REQUIRED'],
  ])('rejects unsafe %s candidate facts before a write', (_label, changes, reason) => {
    expect(validateTatoebaSentenceImportCandidate({
      ...VALID_CANDIDATE,
      ...changes,
    } as TatoebaValidatedSentenceCandidate)).toMatchObject({ ok: false, reason });
  });

  it('accepts CC0 with a null owner and maps it to the canonical registry key', () => {
    const candidate: TatoebaValidatedSentenceCandidate = {
      ...VALID_CANDIDATE,
      sentenceId: '456',
      text: 'Hello',
      license: 'CC0 1.0',
      owner: null,
      sourceUrl: sentenceSourceUrl('456'),
      sourceIdentity: 'TATOEBA:SENTENCE:456',
      attribution: buildTatoebaAttribution({
        sentenceId: '456',
        sourceUrl: sentenceSourceUrl('456'),
        license: 'CC0 1.0',
        owner: null,
        transformationNote: null,
      }),
    };

    expect(validateTatoebaSentenceImportCandidate(candidate)).toMatchObject({
      ok: true,
      libraryLicenseKey: 'CC0_1_0',
      lockIdentity: 'OPEN_DATASET:TATOEBA:SENTENCE:456',
    });
  });
});
