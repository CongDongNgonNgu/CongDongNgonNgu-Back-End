import { describe, expect, it } from '@jest/globals';
import {
  COMMUNITY_CEFR_LEVELS,
  COMMUNITY_POST_TYPES,
  COMMUNITY_VISIBILITIES,
} from './community.types';
import {
  normalizeCommunityContent,
  normalizeCommunityTopic,
} from './community.normalization';

describe('Community contracts', () => {
  it('keeps the documented post types on one extensible contract', () => {
    expect(COMMUNITY_POST_TYPES).toEqual([
      'DISCUSSION',
      'QUESTION',
      'RESOURCE',
      'LEARNING_JOURNAL',
      'CULTURE',
      'PRONUNCIATION_REQUEST',
      'CORRECTION_REQUEST',
      'CHALLENGE',
    ]);
  });

  it('normalizes multilingual plain text without corrupting CJK or Vietnamese content', () => {
    expect(normalizeCommunityContent('  Xin\tchào\r\n\r\n 世界  ')).toBe('Xin chào\n\n世界');
  });

  it('rejects content with no meaningful Unicode characters and oversized content', () => {
    expect(() => normalizeCommunityContent(' \n\t ')).toThrow('COMMUNITY_CONTENT_EMPTY');
    expect(() => normalizeCommunityContent('x'.repeat(20_001))).toThrow('COMMUNITY_CONTENT_TOO_LONG');
  });

  it('normalizes structured topics to stable Unicode-safe slugs', () => {
    expect(normalizeCommunityTopic('  Du lịch  hè ')).toBe('du-lịch-hè');
    expect(normalizeCommunityTopic(null)).toBeNull();
    expect(() => normalizeCommunityTopic('grammar!')).toThrow('COMMUNITY_TOPIC_INVALID');
  });

  it('keeps CEFR and visibility values deliberately bounded', () => {
    expect(COMMUNITY_CEFR_LEVELS).toEqual(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
    expect(COMMUNITY_VISIBILITIES).toEqual(['PUBLIC', 'PRIVATE']);
  });
});
