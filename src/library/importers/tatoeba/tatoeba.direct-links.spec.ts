import { describe, expect, it } from '@jest/globals';

import { buildTatoebaTranslationCandidates } from './tatoeba.direct-links';
import type {
  TatoebaConfiguredDirection,
  TatoebaLinkRow,
  TatoebaValidatedSentenceCandidate,
} from './tatoeba.types';

function candidate(sentenceId: string, projectLanguage: TatoebaValidatedSentenceCandidate['projectLanguage']): TatoebaValidatedSentenceCandidate {
  return {
    provider: 'TATOEBA',
    sentenceId,
    projectLanguage,
    text: `${projectLanguage}-${sentenceId}`,
    license: 'CC0 1.0',
    owner: null,
    sourceUrl: `https://tatoeba.org/en/sentences/show/${sentenceId}`,
    sourceIdentity: `TATOEBA:SENTENCE:${sentenceId}`,
    attribution: `Tatoeba sentence ${sentenceId}.`,
    importBatch: 'test-batch',
    snapshotId: 'test',
    apiCheckedAt: '2026-09-28T00:00:01.000Z',
    transformationNote: null,
  };
}

function link(sentenceId: string, translationId: string, lineNumber: number): TatoebaLinkRow {
  return { sentenceId, translationId, lineNumber };
}

const viToEn: TatoebaConfiguredDirection[] = [{ sourceLanguage: 'vi', targetLanguage: 'en' }];

describe('Tatoeba direct-link candidate construction', () => {
  const eligible = new Map([
    ['100', candidate('100', 'vi')],
    ['200', candidate('200', 'en')],
  ]);

  it('collapses reciprocal input rows and keeps directed identity independent of row order', () => {
    const forward = buildTatoebaTranslationCandidates({
      links: [link('100', '200', 1), link('200', '100', 2)],
      eligibleSentences: eligible,
      directions: viToEn,
    });
    const reverse = buildTatoebaTranslationCandidates({
      links: [link('200', '100', 1), link('100', '200', 2)],
      eligibleSentences: eligible,
      directions: viToEn,
    });

    expect(forward.candidates).toEqual(reverse.candidates);
    expect(forward.candidates).toHaveLength(1);
    expect(forward.candidates[0]).toMatchObject({
      durableIdentity: 'TATOEBA:LINK:DIRECT:100:200',
      inputPairIdentity: 'TATOEBA:PAIR:100:200',
      primaryLanguageCode: 'vi',
      secondaryLanguageCode: 'en',
      sourceSentenceId: '100',
      targetSentenceId: '200',
    });
    expect(forward.candidates[0].sourceProvenance).toMatchObject({
      sourceId: 'TATOEBA:LINK:DIRECT:100:200:SOURCE',
      endpointSentenceId: '100',
      endpointRole: 'SOURCE',
      relationIdentity: 'TATOEBA:LINK:DIRECT:100:200',
      inputPairIdentity: 'TATOEBA:PAIR:100:200',
      primaryLanguageCode: 'vi',
      secondaryLanguageCode: 'en',
    });
    expect(forward.candidates[0].targetProvenance).toMatchObject({
      sourceId: 'TATOEBA:LINK:DIRECT:100:200:TARGET',
      endpointSentenceId: '200',
      endpointRole: 'TARGET',
    });
    expect(forward.counts.reciprocalPairsCollapsed).toBe(1);
  });

  it('creates only the explicitly configured reverse direction', () => {
    const reverse = buildTatoebaTranslationCandidates({
      links: [link('100', '200', 1)],
      eligibleSentences: eligible,
      directions: [{ sourceLanguage: 'en', targetLanguage: 'vi' }],
    });
    expect(reverse.candidates[0].durableIdentity).toBe('TATOEBA:LINK:DIRECT:200:100');
  });

  it('allows two distinct candidates when both directions are configured', () => {
    const both = buildTatoebaTranslationCandidates({
      links: [link('100', '200', 1)],
      eligibleSentences: eligible,
      directions: [
        { sourceLanguage: 'vi', targetLanguage: 'en' },
        { sourceLanguage: 'en', targetLanguage: 'vi' },
      ],
    });
    expect(both.candidates.map((item) => item.durableIdentity)).toEqual([
      'TATOEBA:LINK:DIRECT:100:200',
      'TATOEBA:LINK:DIRECT:200:100',
    ]);
    expect(both.counts.directionConflicts).toBe(0);
  });

  it('fails closed for missing endpoints and excludes same-language links', () => {
    const result = buildTatoebaTranslationCandidates({
      links: [link('100', '999', 1), link('100', '100', 2)],
      eligibleSentences: eligible,
      directions: viToEn,
    });
    expect(result.candidates).toHaveLength(0);
    expect(result.counts.missingLinkEndpoints).toBe(1);
    expect(result.counts.sameLanguageLinks).toBe(1);
  });
});
