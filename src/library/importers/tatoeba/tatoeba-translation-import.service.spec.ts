import { describe, expect, it, jest } from '@jest/globals';

import { buildTatoebaAttribution, sentenceSourceUrl } from './tatoeba.attribution';
import { directTranslationIdentity, inputPairIdentity, translationProvenanceSourceId } from './tatoeba.identities';
import { TatoebaTranslationImportService } from './tatoeba-translation-import.service';
import type { TatoebaTranslationImportRepository } from './tatoeba-translation-import.types';
import type { TatoebaTranslationCandidate } from './tatoeba.types';

const ACTOR_ID = '00000000-0000-4000-8000-000000000001';
const sourceId = '100';
const targetId = '200';
const durableIdentity = directTranslationIdentity(sourceId, targetId);
const pairIdentity = inputPairIdentity(sourceId, targetId);

function candidate(): TatoebaTranslationCandidate {
  const sourceUrl = sentenceSourceUrl(sourceId);
  const targetUrl = sentenceSourceUrl(targetId);
  return {
    provider: 'TATOEBA',
    inputPairIdentity: pairIdentity,
    durableIdentity,
    primaryLanguageCode: 'vi',
    secondaryLanguageCode: 'en',
    sourceSentenceId: sourceId,
    targetSentenceId: targetId,
    sourceText: 'Xin chào',
    translatedText: 'Hello',
    sourceProvenance: {
      sourceId: translationProvenanceSourceId(sourceId, targetId, 'SOURCE'),
      sourceUrl,
      license: 'CC BY 2.0 FR',
      owner: 'alice',
      attribution: buildTatoebaAttribution({ sentenceId: sourceId, sourceUrl, license: 'CC BY 2.0 FR', owner: 'alice', transformationNote: null }),
      endpointSentenceId: sourceId,
      endpointRole: 'SOURCE',
      relationIdentity: durableIdentity,
      inputPairIdentity: pairIdentity,
      primaryLanguageCode: 'vi',
      secondaryLanguageCode: 'en',
      importBatch: 'tatoeba-08d3c-test',
      snapshotId: 'TATOEBA-SNAPSHOT-test',
      apiCheckedAt: '2026-09-28T00:00:01.000Z',
      transformationNote: null,
    },
    targetProvenance: {
      sourceId: translationProvenanceSourceId(sourceId, targetId, 'TARGET'),
      sourceUrl: targetUrl,
      license: 'CC0 1.0',
      owner: null,
      attribution: buildTatoebaAttribution({ sentenceId: targetId, sourceUrl: targetUrl, license: 'CC0 1.0', owner: null, transformationNote: null }),
      endpointSentenceId: targetId,
      endpointRole: 'TARGET',
      relationIdentity: durableIdentity,
      inputPairIdentity: pairIdentity,
      primaryLanguageCode: 'vi',
      secondaryLanguageCode: 'en',
      importBatch: 'tatoeba-08d3c-test',
      snapshotId: 'TATOEBA-SNAPSHOT-test',
      apiCheckedAt: '2026-09-28T00:00:02.000Z',
      transformationNote: null,
    },
  };
}

describe('Tatoeba translation import service', () => {
  it('quarantines invalid actor input without crossing the repository boundary', async () => {
    const importTranslation = jest.fn<TatoebaTranslationImportRepository['importTranslation']>();
    const service = new TatoebaTranslationImportService({ importTranslation });

    await expect(service.importTranslation({ actorUserId: 'not-a-uuid', candidate: candidate() })).resolves.toMatchObject({
      status: 'QUARANTINED',
      reason: 'TATOEBA_IMPORT_ACTOR_ID_INVALID',
    });
    expect(importTranslation).not.toHaveBeenCalled();
  });

  it('quarantines unsafe translation candidates without durable writes', async () => {
    const importTranslation = jest.fn<TatoebaTranslationImportRepository['importTranslation']>();
    const service = new TatoebaTranslationImportService({ importTranslation });
    const unsafe = candidate();
    unsafe.sourceText = '   ';

    await expect(service.importTranslation({ actorUserId: ACTOR_ID, candidate: unsafe })).resolves.toMatchObject({
      status: 'QUARANTINED',
      reason: 'TATOEBA_EMPTY_TEXT',
      durableResourceCreated: false,
    });
    expect(importTranslation).not.toHaveBeenCalled();
  });

  it('passes a validated candidate without changing exact endpoint text', async () => {
    const value = candidate();
    const importTranslation = jest.fn<TatoebaTranslationImportRepository['importTranslation']>().mockResolvedValue({
      status: 'CREATED',
      durableIdentity,
      inputPairIdentity: pairIdentity,
      resourceId: '00000000-0000-4000-8000-000000000010',
      reviewState: 'COMMUNITY_REVIEW',
      durableResourceCreated: true,
    });
    const service = new TatoebaTranslationImportService({ importTranslation });

    await expect(service.importTranslation({ actorUserId: ACTOR_ID, candidate: value })).resolves.toMatchObject({ status: 'CREATED' });
    expect(importTranslation).toHaveBeenCalledWith({ actorUserId: ACTOR_ID, candidate: value });
    expect(value.sourceText).toBe('Xin chào');
    expect(value.translatedText).toBe('Hello');
  });
});
