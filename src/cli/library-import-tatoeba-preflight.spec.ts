import { describe, expect, it, jest } from '@jest/globals';

import {
  executeTatoebaPreflightCli,
  parseTatoebaPreflightCliArgs,
} from './library-import-tatoeba-preflight';
import type { TatoebaImportPreflightRepository } from '../library/importers/tatoeba/tatoeba-preflight.types';
import type { TatoebaPreflightRepositoryHandle } from '../library/importers/tatoeba/postgres-tatoeba-preflight.repository';

const ACTOR_ID = '00000000-0000-4000-8000-000000000001';

function passingRepository(): TatoebaImportPreflightRepository {
  return {
    withReadOnlyTransaction: async (callback) => callback({
      findImportActor: async (userId) => ({ userId, status: 'ACTIVE', roles: ['ADMIN'] }),
      findLicense: async (key) => key === 'CC_BY_2_0_FR'
        ? {
          licenseKey: key,
          displayName: 'CC BY 2.0 France',
          canonicalUrl: 'https://creativecommons.org/licenses/by/2.0/fr/',
          attributionRequired: true,
          redistributionAllowed: true,
          active: true,
        }
        : {
          licenseKey: key,
          displayName: 'CC0 1.0',
          canonicalUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
          attributionRequired: false,
          redistributionAllowed: true,
          active: true,
        },
    }),
  };
}

describe('Tatoeba preflight CLI boundary', () => {
  it('requires TEST and an explicit actor UUID', () => {
    expect(() => parseTatoebaPreflightCliArgs([])).toThrow(expect.objectContaining({
      code: 'TATOEBA_IMPORT_ENVIRONMENT_REQUIRED',
    }));
    expect(() => parseTatoebaPreflightCliArgs(['--environment', 'TEST'])).toThrow(expect.objectContaining({
      code: 'TATOEBA_IMPORT_ACTOR_ID_INVALID',
    }));
    expect(() => parseTatoebaPreflightCliArgs(['--environment', 'PRODUCTION', '--actor-user-id', ACTOR_ID]))
      .toThrow(expect.objectContaining({ code: 'TATOEBA_IMPORT_PRODUCTION_UNSUPPORTED' }));
    expect(() => parseTatoebaPreflightCliArgs(['--environment', 'TEST', '--actor-user-id', 'bad']))
      .toThrow(expect.objectContaining({ code: 'TATOEBA_IMPORT_ACTOR_ID_INVALID' }));
  });

  it('invokes the preflight only after valid TEST/actor arguments and never accepts a DB URL argument', async () => {
    const createRepository = jest.fn(
      (_databaseUrl: string, _expectedDatabaseName: string): TatoebaPreflightRepositoryHandle => ({
        repository: passingRepository(),
        close: async () => undefined,
      }),
    );
    const output = { write: jest.fn() };
    const error = { write: jest.fn() };

    const exitCode = await executeTatoebaPreflightCli([
      '--environment', 'TEST',
      '--actor-user-id', ACTOR_ID,
    ], output, error, {
      env: {
        TATOEBA_IMPORT_DATABASE_URL: 'postgresql://test.example/db',
        TATOEBA_IMPORT_EXPECTED_DATABASE_NAME: 'congdongngonngu_test',
      },
      createRepository,
    });

    expect(exitCode).toBe(0);
    expect(createRepository).toHaveBeenCalledWith(
      'postgresql://test.example/db',
      'congdongngonngu_test',
    );
    expect(output.write).toHaveBeenCalledWith(expect.stringContaining('"status":"PASS"'));
    expect(error.write).not.toHaveBeenCalled();
  });

  it('fails before opening a pool when the dedicated DB URL or target identity is absent', async () => {
    const createRepository = jest.fn(
      (_databaseUrl: string, _expectedDatabaseName: string): TatoebaPreflightRepositoryHandle => {
        throw new Error('should not be called');
      },
    );
    const error = { write: jest.fn() };

    const missingUrl = await executeTatoebaPreflightCli([
      '--environment', 'TEST', '--actor-user-id', ACTOR_ID,
    ], { write: jest.fn() }, error, {
      env: { TATOEBA_IMPORT_EXPECTED_DATABASE_NAME: 'congdongngonngu_test' },
      createRepository,
    });
    expect(missingUrl).toBe(2);
    expect(createRepository).not.toHaveBeenCalled();

    const missingTarget = await executeTatoebaPreflightCli([
      '--environment', 'TEST', '--actor-user-id', ACTOR_ID,
    ], { write: jest.fn() }, error, {
      env: { TATOEBA_IMPORT_DATABASE_URL: 'postgresql://secret:password@example.test/db' },
      createRepository,
    });
    expect(missingTarget).toBe(2);
    expect(createRepository).not.toHaveBeenCalled();
    expect(error.write.mock.calls.flat().join('\n')).not.toContain('password');
  });

  it('sanitizes DB failures and never prints the connection string', async () => {
    const output = { write: jest.fn() };
    const error = { write: jest.fn() };
    const databaseUrl = 'postgresql://secret:password@example.test/db';
    const exitCode = await executeTatoebaPreflightCli([
      '--environment', 'TEST', '--actor-user-id', ACTOR_ID,
    ], output, error, {
      env: {
        TATOEBA_IMPORT_DATABASE_URL: databaseUrl,
        TATOEBA_IMPORT_EXPECTED_DATABASE_NAME: 'congdongngonngu_test',
      },
      createRepository: (): TatoebaPreflightRepositoryHandle => ({
        repository: {
          withReadOnlyTransaction: async () => {
            throw new Error(databaseUrl);
          },
        },
        close: async () => undefined,
      }),
    });

    expect(exitCode).toBe(2);
    expect(error.write).toHaveBeenCalledWith(expect.stringContaining('TATOEBA_IMPORT_PREFLIGHT_DB_UNAVAILABLE'));
    expect(error.write.mock.calls.flat().join('\n')).not.toContain(databaseUrl);
  });
});
