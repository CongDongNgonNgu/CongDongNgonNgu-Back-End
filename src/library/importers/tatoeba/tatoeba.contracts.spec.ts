import { describe, expect, it } from '@jest/globals';

import {
  TATOEBA_LANGUAGE_MAPPING,
  TATOEBA_SUPPORTED_LICENSES,
} from './tatoeba.constants';
import {
  mapTatoebaLanguage,
  parseConfiguredDirections,
  parseConfiguredLanguages,
} from './tatoeba.languages';
import {
  directTranslationIdentity,
  inputPairIdentity,
  sentenceSourceIdentity,
  translationLockIdentity,
} from './tatoeba.identities';

describe('Tatoeba 08D3A contracts', () => {
  it('maps only the approved Tatoeba language codes', () => {
    expect(TATOEBA_LANGUAGE_MAPPING).toEqual({
      vie: 'vi',
      eng: 'en',
      cmn: 'zh',
      jpn: 'ja',
      kor: 'ko',
      fra: 'fr',
      deu: 'de',
      spa: 'es',
    });
    expect(mapTatoebaLanguage('vie')).toBe('vi');
    expect(mapTatoebaLanguage('zho')).toBeNull();
    expect(mapTatoebaLanguage(null)).toBeNull();
  });

  it('keeps license and language configuration explicit', () => {
    expect(TATOEBA_SUPPORTED_LICENSES).toEqual(['CC BY 2.0 FR', 'CC0 1.0']);
    expect(parseConfiguredLanguages('vi,en,zh')).toEqual(['vi', 'en', 'zh']);
    expect(parseConfiguredDirections('vi:en,en:vi')).toEqual([
      { sourceLanguage: 'vi', targetLanguage: 'en' },
      { sourceLanguage: 'en', targetLanguage: 'vi' },
    ]);
  });

  it('uses distinct directed durable identities and shared input-pair identity', () => {
    expect(sentenceSourceIdentity('123')).toBe('TATOEBA:SENTENCE:123');
    expect(inputPairIdentity('456', '123')).toBe('TATOEBA:PAIR:123:456');
    expect(directTranslationIdentity('123', '456')).toBe('TATOEBA:LINK:DIRECT:123:456');
    expect(directTranslationIdentity('456', '123')).toBe('TATOEBA:LINK:DIRECT:456:123');
    expect(translationLockIdentity('123', '456')).toBe(
      'OPEN_DATASET:TATOEBA:LINK:DIRECT:123:456',
    );
  });
});
