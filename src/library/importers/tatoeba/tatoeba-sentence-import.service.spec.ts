import { describe, expect, it, jest } from '@jest/globals';

import { buildTatoebaAttribution, sentenceSourceUrl } from './tatoeba.attribution';
import { TatoebaSentenceImportService } from './tatoeba-sentence-import.service';
import type { TatoebaSentenceImportRepository } from './tatoeba-sentence-import.types';
import type { TatoebaValidatedSentenceCandidate } from './tatoeba.types';

const candidate: TatoebaValidatedSentenceCandidate = {
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

describe('Tatoeba sentence import service', () => {
  it('quarantines a new unsafe candidate without opening the repository boundary', async () => {
    const importSentence = jest.fn<TatoebaSentenceImportRepository['importSentence']>();
    const repository: TatoebaSentenceImportRepository = {
      importSentence,
    };
    const service = new TatoebaSentenceImportService(repository);

    const result = await service.importSentence({
      actorUserId: '00000000-0000-4000-8000-000000000001',
      candidate: { ...candidate, text: '   ' },
    });

    expect(result).toMatchObject({
      status: 'QUARANTINED',
      reason: 'TATOEBA_EMPTY_TEXT',
      durableResourceCreated: false,
    });
    expect(importSentence).not.toHaveBeenCalled();
  });

  it('passes a safe candidate to the transaction repository without changing exact text', async () => {
    const importSentence = jest.fn<TatoebaSentenceImportRepository['importSentence']>()
      .mockResolvedValue({
        status: 'CREATED',
        sourceIdentity: candidate.sourceIdentity,
        resourceId: '00000000-0000-4000-8000-000000000010',
        reviewState: 'COMMUNITY_REVIEW',
        durableResourceCreated: true,
      });
    const repository: TatoebaSentenceImportRepository = {
      importSentence,
    };
    const service = new TatoebaSentenceImportService(repository);

    await expect(service.importSentence({
      actorUserId: '00000000-0000-4000-8000-000000000001',
      candidate,
    })).resolves.toMatchObject({ status: 'CREATED' });

    expect(importSentence).toHaveBeenCalledWith({
      actorUserId: '00000000-0000-4000-8000-000000000001',
      candidate,
    });
  });
});
