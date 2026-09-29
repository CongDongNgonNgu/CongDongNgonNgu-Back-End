import { describe, expect, it, jest } from '@jest/globals';

import {
  executeTatoebaTranslationImportCli,
  parseTatoebaTranslationImportCliArgs,
} from './library-import-tatoeba-translation';
import { buildTatoebaAttribution, sentenceSourceUrl } from '../library/importers/tatoeba/tatoeba.attribution';
import { directTranslationIdentity, inputPairIdentity, translationProvenanceSourceId } from '../library/importers/tatoeba/tatoeba.identities';
import type {
  TatoebaTranslationImportRepository,
  TatoebaTranslationImportRepositoryHandle,
  TatoebaTranslationImportTarget,
} from '../library/importers/tatoeba/tatoeba-translation-import.types';
import type { TatoebaTranslationCandidate } from '../library/importers/tatoeba/tatoeba.types';

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
      importBatch: 'test-batch',
      snapshotId: 'test-snapshot',
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
      importBatch: 'test-batch',
      snapshotId: 'test-snapshot',
      apiCheckedAt: '2026-09-28T00:00:02.000Z',
      transformationNote: null,
    },
  };
}

const env = {
  TATOEBA_IMPORT_DATABASE_URL: 'postgresql://secret-user:secret-password@test.example/testdb?sslmode=require&token=secret-token',
  TATOEBA_IMPORT_EXPECTED_DATABASE_HOST: 'TEST.EXAMPLE',
  TATOEBA_IMPORT_EXPECTED_DATABASE_NAME: 'testdb',
  TATOEBA_IMPORT_EXPECTED_DATABASE_USER: 'secret-user',
};

describe('Tatoeba translation import CLI boundary', () => {
  it('requires exact TEST, an explicit actor, and a candidate file', () => {
    expect(() => parseTatoebaTranslationImportCliArgs([])).toThrow(expect.objectContaining({ code: 'TATOEBA_IMPORT_ENVIRONMENT_REQUIRED' }));
    expect(() => parseTatoebaTranslationImportCliArgs(['--environment', 'PRODUCTION', '--actor-user-id', ACTOR_ID, '--candidate-file', 'candidate.json']))
      .toThrow(expect.objectContaining({ code: 'TATOEBA_IMPORT_PRODUCTION_UNSUPPORTED' }));
    expect(() => parseTatoebaTranslationImportCliArgs(['--environment', 'TEST', '--actor-user-id', ACTOR_ID]))
      .toThrow(expect.objectContaining({ code: 'TATOEBA_IMPORT_ARGUMENT_INVALID' }));
  });

  it('parses the target before creating the repository and emits only a safe outcome', async () => {
    const output = { write: jest.fn() };
    const errorOutput = { write: jest.fn() };
    const close = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const importTranslation = jest.fn<TatoebaTranslationImportRepository['importTranslation']>().mockResolvedValue({
      status: 'CREATED',
      durableIdentity,
      inputPairIdentity: pairIdentity,
      resourceId: '00000000-0000-4000-8000-000000000010',
      reviewState: 'COMMUNITY_REVIEW',
      durableResourceCreated: true,
    });
    const createRepository = jest.fn().mockImplementation(() => ({ repository: { importTranslation }, close }));
    const createRepositoryDependency = createRepository as unknown as (target: TatoebaTranslationImportTarget) => TatoebaTranslationImportRepositoryHandle;

    await expect(executeTatoebaTranslationImportCli(
      ['--environment', 'TEST', '--actor-user-id', ACTOR_ID, '--candidate-file', 'candidate.json'],
      output,
      errorOutput,
      { env, readCandidate: async () => candidate(), createRepository: createRepositoryDependency },
    )).resolves.toBe(0);

    expect(createRepository).toHaveBeenCalledWith(expect.objectContaining({ environment: 'TEST', hostname: 'test.example' }));
    expect(output.write.mock.calls.flat().join('\n')).toContain('"status":"CREATED"');
    expect(output.write.mock.calls.flat().join('\n')).not.toContain('secret-password');
    expect(output.write.mock.calls.flat().join('\n')).not.toContain('secret-token');
    expect(errorOutput.write).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('fails closed without creating a repository when the target URL is absent', async () => {
    const createRepository = jest.fn();
    const errorOutput = { write: jest.fn() };
    await expect(executeTatoebaTranslationImportCli(
      ['--environment', 'TEST', '--actor-user-id', ACTOR_ID, '--candidate-file', 'candidate.json'],
      { write: jest.fn() },
      errorOutput,
      {
        env: {
          TATOEBA_IMPORT_EXPECTED_DATABASE_HOST: 'test.example',
          TATOEBA_IMPORT_EXPECTED_DATABASE_NAME: 'testdb',
          TATOEBA_IMPORT_EXPECTED_DATABASE_USER: 'secret-user',
        },
        readCandidate: async () => candidate(),
      },
    )).resolves.toBe(1);
    expect(createRepository).not.toHaveBeenCalled();
    expect(errorOutput.write.mock.calls.flat().join('\n')).toContain('TATOEBA_IMPORT_DATABASE_URL_REQUIRED');
  });
});
