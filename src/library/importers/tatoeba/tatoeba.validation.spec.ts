import { describe, expect, it } from '@jest/globals';

import { buildTatoebaAttribution, sentenceSourceUrl } from './tatoeba.attribution';
import { validateTatoebaSentenceCandidate } from './tatoeba.validation';
import type {
  TatoebaApiSentenceCheck,
  TatoebaBulkSentenceRow,
  TatoebaSnapshotMetadata,
} from './tatoeba.types';

const snapshot: TatoebaSnapshotMetadata = {
  snapshotId: 'TATOEBA-SNAPSHOT-test',
  retrievedAt: '2026-09-28T00:00:00.000Z',
  artifacts: [],
};

function bulk(overrides: Partial<TatoebaBulkSentenceRow> = {}): TatoebaBulkSentenceRow {
  return {
    sentenceId: '123',
    tatoebaLanguage: 'vie',
    text: 'Xin chào',
    username: 'owner_1',
    dateAdded: '2026-01-01',
    dateLastModified: '2026-01-02',
    lineNumber: 1,
    filePath: 'sentences_detailed.csv',
    ...overrides,
  };
}

function api(overrides: Partial<TatoebaApiSentenceCheck['facts']> = {}): TatoebaApiSentenceCheck {
  return {
    checkedAt: '2026-09-28T00:00:01.000Z',
    facts: {
      sentenceId: '123',
      tatoebaLanguage: 'vie',
      text: 'Xin chào',
      license: 'CC BY 2.0 FR',
      owner: 'owner_1',
      isUnapproved: false,
      ...overrides,
    },
  };
}

describe('Tatoeba sentence validation and attribution', () => {
  it('accepts a matching CC BY sentence and builds safe attribution without a false modification notice', () => {
    const result = validateTatoebaSentenceCandidate({
      bulk: bulk(),
      api: api(),
      cc0SentenceIds: new Set(),
      snapshot,
      importBatch: 'tatoeba-dry-run-test',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate).toMatchObject({
        sentenceId: '123',
        projectLanguage: 'vi',
        license: 'CC BY 2.0 FR',
        owner: 'owner_1',
        sourceUrl: sentenceSourceUrl('123'),
        transformationNote: null,
      });
      expect(result.candidate.attribution).toContain('Tatoeba');
      expect(result.candidate.attribution).toContain('owner_1');
      expect(result.candidate.attribution).toContain('CC BY 2.0 France');
      expect(result.candidate.attribution).not.toContain('Modified');
    }
  });

  it('requires CC0 snapshot membership to agree with API CC0 state', () => {
    const cc0Accepted = validateTatoebaSentenceCandidate({
      bulk: bulk({ username: null }),
      api: api({ license: 'CC0 1.0', owner: null }),
      cc0SentenceIds: new Set(['123']),
      snapshot,
      importBatch: 'tatoeba-dry-run-test',
    });
    const missingSnapshot = validateTatoebaSentenceCandidate({
      bulk: bulk({ username: null }),
      api: api({ license: 'CC0 1.0', owner: null }),
      cc0SentenceIds: new Set(),
      snapshot,
      importBatch: 'tatoeba-dry-run-test',
    });
    const wrongApiLicense = validateTatoebaSentenceCandidate({
      bulk: bulk(),
      api: api({ license: 'CC BY 2.0 FR' }),
      cc0SentenceIds: new Set(['123']),
      snapshot,
      importBatch: 'tatoeba-dry-run-test',
    });

    expect(cc0Accepted.ok).toBe(true);
    expect(missingSnapshot).toMatchObject({ ok: false, reason: 'TATOEBA_CC0_MISMATCH' });
    expect(wrongApiLicense).toMatchObject({ ok: false, reason: 'TATOEBA_CC0_MISMATCH' });
  });

  it('quarantines text, language, owner, unsupported language, and missing-owner mismatches', () => {
    const cases = [
      [api({ text: 'Changed' }), new Set<string>(), 'TATOEBA_TEXT_MISMATCH'],
      [api({ tatoebaLanguage: 'eng' }), new Set<string>(), 'TATOEBA_LANGUAGE_MISMATCH'],
      [api({ owner: 'other_owner' }), new Set<string>(), 'TATOEBA_OWNER_MISMATCH'],
      [api({ owner: null }), new Set<string>(), 'TATOEBA_OWNER_REQUIRED', bulk({ username: null })],
      [api(), new Set<string>(), 'TATOEBA_UNSUPPORTED_LANGUAGE', bulk({ tatoebaLanguage: 'zho' })],
    ] as const;

    expect(cases.map(([apiFacts, cc0Ids, expected, override]) => validateTatoebaSentenceCandidate({
      bulk: override ?? bulk(),
      api: apiFacts,
      cc0SentenceIds: cc0Ids,
      snapshot,
      importBatch: 'tatoeba-dry-run-test',
    }))).toEqual(expect.arrayContaining(cases.map(([, , expected]) => expect.objectContaining({ ok: false, reason: expected }))));
  });

  it('preserves CC0 attribution when owner is unknown and adds modification text only when supplied', () => {
    const sourceUrl = sentenceSourceUrl('456');
    const attribution = buildTatoebaAttribution({
      sentenceId: '456',
      sourceUrl,
      license: 'CC0 1.0',
      owner: null,
      transformationNote: null,
    });
    const modified = buildTatoebaAttribution({
      sentenceId: '456',
      sourceUrl,
      license: 'CC0 1.0',
      owner: null,
      transformationNote: 'No transformation in 08D3A.',
    });

    expect(attribution).toContain('CC0 1.0');
    expect(attribution).not.toContain('Owner:');
    expect(modified).toContain('Modified: No transformation in 08D3A.');
  });
});
