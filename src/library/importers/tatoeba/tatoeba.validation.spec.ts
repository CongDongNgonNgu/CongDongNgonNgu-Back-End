import { describe, expect, it } from '@jest/globals';

import { buildTatoebaAttribution, sentenceSourceUrl } from './tatoeba.attribution';
import { libraryTextCharacterLength } from './tatoeba.text';
import { validateTatoebaSentenceCandidate } from './tatoeba.validation';
import type {
  TatoebaApiSentenceCheck,
  TatoebaBulkSentenceRow,
  TatoebaSnapshotMetadata,
} from './tatoeba.types';

const snapshot: TatoebaSnapshotMetadata = {
  snapshotId: 'TATOEBA-SNAPSHOT-test',
  snapshotRetrievedAt: null,
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
  it('requires exact CC BY owner agreement between bulk and API snapshots', () => {
    const cases = [
      {
        name: 'bulk owner missing while API owner is present',
        bulk: bulk({ username: null }),
        api: api({ owner: 'alice' }),
        expected: 'TATOEBA_OWNER_MISMATCH',
      },
      {
        name: 'bulk owner present while API owner is missing',
        bulk: bulk({ username: 'alice' }),
        api: api({ owner: null }),
        expected: 'TATOEBA_OWNER_MISMATCH',
      },
      {
        name: 'both owners missing',
        bulk: bulk({ username: null }),
        api: api({ owner: null }),
        expected: 'TATOEBA_OWNER_REQUIRED',
      },
      {
        name: 'both owners agree',
        bulk: bulk({ username: 'alice' }),
        api: api({ owner: 'alice' }),
        expected: 'PASS',
      },
    ] as const;

    for (const testCase of cases) {
      const result = validateTatoebaSentenceCandidate({
        bulk: testCase.bulk,
        api: testCase.api,
        cc0SentenceIds: new Set(),
        snapshot,
        importBatch: 'tatoeba-dry-run-test',
      });

      if (testCase.expected === 'PASS') expect(result.ok).toBe(true);
      else expect(result).toMatchObject({ ok: false, reason: testCase.expected });
    }
  });

  it('allows a null owner for CC0 but rejects disagreement when both CC0 owners are known', () => {
    const nullOwner = validateTatoebaSentenceCandidate({
      bulk: bulk({ username: null }),
      api: api({ license: 'CC0 1.0', owner: null }),
      cc0SentenceIds: new Set(['123']),
      snapshot,
      importBatch: 'tatoeba-dry-run-test',
    });
    const disagreement = validateTatoebaSentenceCandidate({
      bulk: bulk({ username: 'alice' }),
      api: api({ license: 'CC0 1.0', owner: 'bob' }),
      cc0SentenceIds: new Set(['123']),
      snapshot,
      importBatch: 'tatoeba-dry-run-test',
    });

    expect(nullOwner.ok).toBe(true);
    expect(disagreement).toMatchObject({ ok: false, reason: 'TATOEBA_OWNER_MISMATCH' });
  });

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

  it('aligns sentence text eligibility with the Library character and blank-text contract', () => {
    const exactLimit = 'x'.repeat(20_000);
    const overLimit = 'x'.repeat(20_001);
    const emojiText = '😀'.repeat(20_000);
    const paddedText = '  Xin chào  ';

    const exactLimitResult = validateTatoebaSentenceCandidate({
      bulk: bulk({ text: exactLimit }),
      api: api({ text: exactLimit }),
      cc0SentenceIds: new Set(),
      snapshot,
      importBatch: 'tatoeba-dry-run-test',
    });
    const overLimitBulkResult = validateTatoebaSentenceCandidate({
      bulk: bulk({ text: overLimit }),
      api: api({ text: overLimit }),
      cc0SentenceIds: new Set(),
      snapshot,
      importBatch: 'tatoeba-dry-run-test',
    });
    const overLimitApiResult = validateTatoebaSentenceCandidate({
      bulk: bulk({ text: exactLimit }),
      api: api({ text: overLimit }),
      cc0SentenceIds: new Set(),
      snapshot,
      importBatch: 'tatoeba-dry-run-test',
    });
    const emojiResult = validateTatoebaSentenceCandidate({
      bulk: bulk({ text: emojiText }),
      api: api({ text: emojiText }),
      cc0SentenceIds: new Set(),
      snapshot,
      importBatch: 'tatoeba-dry-run-test',
    });
    const paddedResult = validateTatoebaSentenceCandidate({
      bulk: bulk({ text: paddedText }),
      api: api({ text: paddedText }),
      cc0SentenceIds: new Set(),
      snapshot,
      importBatch: 'tatoeba-dry-run-test',
    });
    const spacesOnlyResult = validateTatoebaSentenceCandidate({
      bulk: bulk({ text: '     ' }),
      api: api({ text: '     ' }),
      cc0SentenceIds: new Set(),
      snapshot,
      importBatch: 'tatoeba-dry-run-test',
    });
    const emptyResult = validateTatoebaSentenceCandidate({
      bulk: bulk({ text: '' }),
      api: api({ text: '' }),
      cc0SentenceIds: new Set(),
      snapshot,
      importBatch: 'tatoeba-dry-run-test',
    });

    expect(libraryTextCharacterLength(exactLimit)).toBe(20_000);
    expect(libraryTextCharacterLength(emojiText)).toBe(20_000);
    expect(exactLimitResult.ok).toBe(true);
    expect(overLimitBulkResult).toMatchObject({ ok: false, reason: 'TATOEBA_TEXT_TOO_LONG' });
    expect(overLimitApiResult).toMatchObject({ ok: false, reason: 'TATOEBA_TEXT_TOO_LONG' });
    expect(emojiResult.ok).toBe(true);
    expect(paddedResult).toMatchObject({ ok: true });
    if (paddedResult.ok) expect(paddedResult.candidate.text).toBe(paddedText);
    expect(spacesOnlyResult).toMatchObject({ ok: false, reason: 'TATOEBA_EMPTY_TEXT' });
    expect(emptyResult).toMatchObject({ ok: false, reason: 'TATOEBA_EMPTY_TEXT' });
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
