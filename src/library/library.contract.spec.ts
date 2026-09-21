import {
  assertLibraryReviewTransition,
  mergeProvenanceEntries,
  normalizeLibraryProvenanceInput,
  normalizeLibraryResourceInput,
} from './library.normalization';
import type {
  LibraryProvenanceInput,
  LibraryResourceType,
} from './library.types';

describe('Open Language Library contracts', () => {
  it.each(resourceFixtures())(
    'normalizes the %s resource family with shared metadata',
    (resourceType, details) => {
      const normalized = normalizeLibraryResourceInput({
        resourceType,
        primaryLanguageCode: ' vi ',
        secondaryLanguageCode: resourceType === 'TRANSLATION' ? 'zh' : undefined,
        cefrLevel: 'b1',
        topics: ['Giao tiếp', '中文', 'giao   tiếp'],
        visibility: 'PUBLIC',
        details,
      });

      expect(normalized).toMatchObject({
        resourceType,
        primaryLanguageCode: 'vi',
        secondaryLanguageCode: resourceType === 'TRANSLATION' ? 'zh' : null,
        cefrLevel: 'B1',
        topics: ['giao-tiếp', '中文'],
        visibility: 'PUBLIC',
      });
    },
  );

  it('rejects an unknown resource type instead of widening the schema', () => {
    expect(() => normalizeLibraryResourceInput({
      resourceType: 'AUDIO_FILE',
      primaryLanguageCode: 'en',
      details: {},
    })).toThrow('LIBRARY_RESOURCE_TYPE_INVALID');
  });

  it('rejects an unknown language code and a translation without a target language', () => {
    expect(() => normalizeLibraryResourceInput({
      resourceType: 'VOCABULARY',
      primaryLanguageCode: 'en us',
      details: { term: 'word', definition: 'meaning' },
    })).toThrow('LIBRARY_LANGUAGE_INVALID');

    expect(() => normalizeLibraryResourceInput({
      resourceType: 'TRANSLATION',
      primaryLanguageCode: 'en',
      details: { sourceText: 'hello', translatedText: 'xin chào' },
    })).toThrow('LIBRARY_SECONDARY_LANGUAGE_REQUIRED');
  });

  it.each(resourceFixtures())(
    'enforces required fields for %s',
    (resourceType, details) => {
      const requiredField = Object.keys(details)[0];
      const missing = { ...details } as Record<string, unknown>;
      delete missing[requiredField];

      expect(() => normalizeLibraryResourceInput({
        resourceType,
        primaryLanguageCode: 'en',
        secondaryLanguageCode: resourceType === 'TRANSLATION' ? 'vi' : undefined,
        details: missing,
      })).toThrow('LIBRARY_REQUIRED_FIELD');
    },
  );

  it('preserves Vietnamese diacritics, CJK text, and meaningful line breaks', () => {
    const normalized = normalizeLibraryResourceInput({
      resourceType: 'SENTENCE',
      primaryLanguageCode: 'vi',
      details: {
        text: '  Tiếng Việt tự nhiên\r\n中文下一行  ',
        context: 'Giao tiếp hằng ngày',
      },
    });

    expect(normalized.details).toEqual({
      resourceType: 'SENTENCE',
      text: 'Tiếng Việt tự nhiên\n中文下一行',
      context: 'Giao tiếp hằng ngày',
    });
  });

  it('normalizes and bounds provenance without trusting external URLs as HTML', () => {
    const normalized = normalizeLibraryProvenanceInput({
      sourceType: 'PHASE06_LIBRARY_CANDIDATE',
      sourceId: ' candidate-1 ',
      sourceUrl: 'https://example.test/source/1',
      licenseKey: 'community-v1',
      attribution: 'Người đóng góp · 社区',
      originalAuthorReference: 'public-author-1',
      originalContributorUserId: '00000000-0000-4000-8000-000000000001',
      importBatch: 'phase06-candidate-2026-09',
      sourcePostId: '00000000-0000-4000-8000-000000000002',
      sourceResponseId: '00000000-0000-4000-8000-000000000003',
      sourceCandidateId: '00000000-0000-4000-8000-000000000004',
      sourceAcceptanceId: '00000000-0000-4000-8000-000000000005',
      transformationHistory: [{
        operation: 'NORMALIZE_WHITESPACE',
        metadata: { preserved: 'true' },
      }],
    });

    expect(normalized).toMatchObject({
      sourceType: 'PHASE06_LIBRARY_CANDIDATE',
      sourceId: 'candidate-1',
      sourceUrl: 'https://example.test/source/1',
      licenseKey: 'COMMUNITY-V1',
      attribution: 'Người đóng góp · 社区',
      sourcePostId: '00000000-0000-4000-8000-000000000002',
      sourceResponseId: '00000000-0000-4000-8000-000000000003',
    });
    expect(() => normalizeLibraryProvenanceInput({
      ...normalized,
      sourceUrl: 'javascript:alert(1)',
    })).toThrow('LIBRARY_SOURCE_URL_INVALID');
  });

  it('merges distinct provenance entries without dropping attribution', () => {
    const first: LibraryProvenanceInput = {
      sourceType: 'COMMUNITY_POST',
      sourceId: 'post-1',
      licenseKey: 'COMMUNITY-V1',
      attribution: 'Contributor A',
    };
    const second: LibraryProvenanceInput = {
      sourceType: 'OPEN_DATASET',
      sourceId: 'dataset-1',
      licenseKey: 'DATASET-V1',
      attribution: 'Dataset source',
    };

    const merged = mergeProvenanceEntries(
      [normalizeLibraryProvenanceInput(first)],
      [first, second],
    );

    expect(merged).toHaveLength(2);
    expect(merged.map((entry) => entry.attribution)).toEqual([
      'Contributor A',
      'Dataset source',
    ]);
  });

  it('rejects a duplicate provenance source key when its attribution conflicts', () => {
    expect(() => mergeProvenanceEntries(
      [normalizeLibraryProvenanceInput({
        sourceType: 'COMMUNITY_POST',
        sourceId: 'post-1',
        licenseKey: 'COMMUNITY-V1',
        attribution: 'Contributor A',
      })],
      [{
        sourceType: 'COMMUNITY_POST',
        sourceId: 'post-1',
        licenseKey: 'COMMUNITY-V1',
        attribution: 'Different attribution',
      }],
    )).toThrow('LIBRARY_PROVENANCE_DUPLICATE');
  });

  it('allows only the explicit review lifecycle transitions', () => {
    expect(assertLibraryReviewTransition('DRAFT', 'COMMUNITY_REVIEW')).toBe('SUBMIT');
    expect(assertLibraryReviewTransition('COMMUNITY_REVIEW', 'VERIFIED')).toBe('VERIFY');
    expect(assertLibraryReviewTransition('COMMUNITY_REVIEW', 'REJECTED')).toBe('REJECT');
    expect(assertLibraryReviewTransition('VERIFIED', 'REJECTED')).toBe('INVALIDATE');
    expect(() => assertLibraryReviewTransition('DRAFT', 'VERIFIED'))
      .toThrow('LIBRARY_REVIEW_TRANSITION_INVALID');
  });
});

function resourceFixtures(): Array<[LibraryResourceType, Record<string, unknown>]> {
  return [
    ['VOCABULARY', { term: 'học', definition: 'to study', partOfSpeech: 'verb' }],
    ['SENTENCE', { text: 'Tôi đang học tiếng Việt.' }],
    ['TRANSLATION', { sourceText: 'Hello', translatedText: 'Xin chào' }],
    ['GRAMMAR_ITEM', { title: 'Classifier usage', explanation: 'Use cái for general objects.' }],
    ['DIALOGUE', { title: 'At the market', turns: [{ speaker: 'A', text: 'Xin chào' }] }],
    ['IDIOM', { expression: 'Nước đến chân mới nhảy', meaning: 'Act at the last moment.' }],
    ['SLANG', { expression: 'xịn', meaning: 'High quality', register: 'informal' }],
    ['CULTURAL_NOTE', { title: 'Tết', body: 'A major Vietnamese celebration.' }],
    ['PRONUNCIATION', { term: 'phở', phonetic: '/fɤː/' }],
    ['LEARNING_COLLECTION', { title: 'Travel basics', description: 'Useful travel language.' }],
  ];
}
