import { describe, expect, it, jest } from '@jest/globals';

import {
  executeTatoebaSentenceImportCli,
  parseTatoebaSentenceImportCliArgs,
} from './library-import-tatoeba-sentence';
import { buildTatoebaAttribution, sentenceSourceUrl } from '../library/importers/tatoeba/tatoeba.attribution';
import type {
  TatoebaSentenceImportRepository,
  TatoebaSentenceImportRepositoryHandle,
  TatoebaSentenceImportTarget,
} from '../library/importers/tatoeba/tatoeba-sentence-import.types';
import type { TatoebaValidatedSentenceCandidate } from '../library/importers/tatoeba/tatoeba.types';

const ACTOR_ID = '00000000-0000-4000-8000-000000000001';
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

const env = {
  TATOEBA_IMPORT_DATABASE_URL: 'postgresql://secret-user:secret-password@test.example/testdb?sslmode=require&token=secret-token',
  TATOEBA_IMPORT_EXPECTED_DATABASE_HOST: 'TEST.EXAMPLE',
  TATOEBA_IMPORT_EXPECTED_DATABASE_NAME: 'testdb',
  TATOEBA_IMPORT_EXPECTED_DATABASE_USER: 'secret-user',
};

describe('Tatoeba sentence import CLI boundary', () => {
  it('requires TEST, an explicit actor, and one bounded candidate file', () => {
    expect(() => parseTatoebaSentenceImportCliArgs([])).toThrow(expect.objectContaining({
      code: 'TATOEBA_IMPORT_ENVIRONMENT_REQUIRED',
    }));
    expect(() => parseTatoebaSentenceImportCliArgs([
      '--environment', 'PRODUCTION', '--actor-user-id', ACTOR_ID, '--candidate-file', 'candidate.json',
    ])).toThrow(expect.objectContaining({ code: 'TATOEBA_IMPORT_PRODUCTION_UNSUPPORTED' }));
    expect(() => parseTatoebaSentenceImportCliArgs([
      '--environment', 'TEST', '--actor-user-id', ACTOR_ID,
    ])).toThrow(expect.objectContaining({ code: 'TATOEBA_IMPORT_ARGUMENT_INVALID' }));
  });

  it('creates the repository only after target parsing and emits only the safe result', async () => {
    const output = { write: jest.fn() };
    const errorOutput = { write: jest.fn() };
    const close = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const importSentence = jest.fn<TatoebaSentenceImportRepository['importSentence']>()
      .mockResolvedValue({
        status: 'CREATED',
        sourceIdentity: candidate.sourceIdentity,
        resourceId: '00000000-0000-4000-8000-000000000010',
        reviewState: 'COMMUNITY_REVIEW',
        durableResourceCreated: true,
      });
    const repository = {
      importSentence,
    };
    const createRepository = jest.fn().mockImplementation(() => ({ repository, close }));
    const createRepositoryDependency = createRepository as unknown as (
      target: TatoebaSentenceImportTarget,
    ) => TatoebaSentenceImportRepositoryHandle;

    await expect(executeTatoebaSentenceImportCli(
      ['--environment', 'TEST', '--actor-user-id', ACTOR_ID, '--candidate-file', 'candidate.json'],
      output,
      errorOutput,
      { env, readCandidate: async () => candidate, createRepository: createRepositoryDependency },
    )).resolves.toBe(0);

    expect(createRepository).toHaveBeenCalledWith(expect.objectContaining({
      environment: 'TEST',
      hostname: 'test.example',
      expectedDatabaseName: 'testdb',
      expectedDatabaseUser: 'secret-user',
    }));
    expect(output.write).toHaveBeenCalledWith(expect.stringContaining('"status":"CREATED"'));
    expect(output.write.mock.calls.flat().join('\n')).not.toContain('secret-password');
    expect(output.write.mock.calls.flat().join('\n')).not.toContain('secret-token');
    expect(errorOutput.write).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('fails before repository creation when the target URL is absent', async () => {
    const output = { write: jest.fn() };
    const errorOutput = { write: jest.fn() };
    const createRepository = jest.fn();

    await expect(executeTatoebaSentenceImportCli(
      ['--environment', 'TEST', '--actor-user-id', ACTOR_ID, '--candidate-file', 'candidate.json'],
      output,
      errorOutput,
      {
        env: {
          TATOEBA_IMPORT_EXPECTED_DATABASE_HOST: 'test.example',
          TATOEBA_IMPORT_EXPECTED_DATABASE_NAME: 'testdb',
          TATOEBA_IMPORT_EXPECTED_DATABASE_USER: 'test-user',
        },
        readCandidate: async () => candidate,
      },
    )).resolves.toBe(1);

    expect(createRepository).not.toHaveBeenCalled();
    expect(errorOutput.write.mock.calls.flat().join('\n')).toContain('TATOEBA_IMPORT_DATABASE_URL_REQUIRED');
    expect(errorOutput.write.mock.calls.flat().join('\n')).not.toContain('secret-password');
  });
});
