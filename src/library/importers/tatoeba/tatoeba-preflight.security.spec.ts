import { describe, expect, it, jest } from '@jest/globals';

import { executeTatoebaPreflightCli } from '../../../cli/library-import-tatoeba-preflight';
import { preflightError } from './tatoeba-preflight.contract';
import { runTatoebaImportPreflight } from './tatoeba-preflight.service';
import { parseTatoebaPreflightDatabaseTarget } from './tatoeba-preflight.target';
import type { TatoebaImportPreflightRepository } from './tatoeba-preflight.types';

const ACTOR_ID = '00000000-0000-4000-8000-000000000001';
const FULL_DATABASE_URL = 'postgresql://LEAK_USER:LEAK_PASSWORD@leak.test/congdongngonngu_test?sslmode=disable&token=LEAK_QUERY_SECRET';
const SENSITIVE_VALUES = [
  FULL_DATABASE_URL,
  'LEAK_USER',
  'LEAK_PASSWORD',
  'LEAK_QUERY_SECRET',
];

function expectNoSensitiveValues(value: string): void {
  for (const sensitiveValue of SENSITIVE_VALUES) {
    expect(value).not.toContain(sensitiveValue);
  }
}

function failingRepository(error: Error): TatoebaImportPreflightRepository {
  return {
    withReadOnlyTransaction: async () => {
      throw error;
    },
  };
}

describe('Tatoeba preflight secret-leak boundaries', () => {
  it('sanitizes typed preflight error messages before they can escape', () => {
    const error = preflightError(
      'TATOEBA_IMPORT_PREFLIGHT_DB_UNAVAILABLE',
      `driver details: ${FULL_DATABASE_URL}; password=LEAK_PASSWORD; for user "LEAK_USER"`,
    );

    expectNoSensitiveValues(error.message);
    expect(error.message).toContain('[REDACTED_DATABASE_URL]');
    expect(error.message).toContain('[REDACTED]');
  });

  it('does not expose secrets from an invalid database URL error', () => {
    expect(() => parseTatoebaPreflightDatabaseTarget(
      'postgresql://LEAK_USER:LEAK_PASSWORD@',
      'leak.test',
      'congdongngonngu_test',
      'readonly_test',
    )).toThrow(expect.objectContaining({ code: 'TATOEBA_IMPORT_DATABASE_URL_INVALID' }));

    try {
      parseTatoebaPreflightDatabaseTarget(
        'postgresql://LEAK_USER:LEAK_PASSWORD@',
        'leak.test',
        'congdongngonngu_test',
        'readonly_test',
      );
    } catch (error) {
      expectNoSensitiveValues(String(error));
    }
  });

  it('does not expose secrets from host target mismatch diagnostics', () => {
    expect(() => parseTatoebaPreflightDatabaseTarget(
      `${FULL_DATABASE_URL}&sslmode=require`,
      'approved.test',
      'congdongngonngu_test',
      'readonly_test',
    )).toThrow(expect.objectContaining({ code: 'TATOEBA_IMPORT_DATABASE_HOST_MISMATCH' }));

    try {
      parseTatoebaPreflightDatabaseTarget(
        `${FULL_DATABASE_URL}&sslmode=require`,
        'approved.test',
        'congdongngonngu_test',
        'readonly_test',
      );
    } catch (error) {
      expectNoSensitiveValues(String(error));
    }
  });

  it('does not expose secrets from remote SSL/TLS rejection diagnostics', () => {
    expect(() => parseTatoebaPreflightDatabaseTarget(
      FULL_DATABASE_URL,
      'leak.test',
      'congdongngonngu_test',
      'readonly_test',
    )).toThrow(expect.objectContaining({ code: 'TATOEBA_IMPORT_REMOTE_SSL_REQUIRED' }));

    try {
      parseTatoebaPreflightDatabaseTarget(
        FULL_DATABASE_URL,
        'leak.test',
        'congdongngonngu_test',
        'readonly_test',
      );
    } catch (error) {
      expectNoSensitiveValues(String(error));
    }
  });

  it('sanitizes connection failures before they become thrown preflight errors', async () => {
    const rawError = new Error(`connect ECONNREFUSED ${FULL_DATABASE_URL}`);

    await expect(runTatoebaImportPreflight({
      environment: 'TEST',
      actorUserId: ACTOR_ID,
    }, failingRepository(rawError))).rejects.toMatchObject({
      code: 'TATOEBA_IMPORT_PREFLIGHT_DB_UNAVAILABLE',
      message: 'Tatoeba import preflight database access failed closed.',
    });

    try {
      await runTatoebaImportPreflight({ environment: 'TEST', actorUserId: ACTOR_ID }, failingRepository(rawError));
    } catch (error) {
      expectNoSensitiveValues(String(error));
    }
  });

  it('sanitizes unexpected database driver errors before they become thrown preflight errors', async () => {
    const rawError = new Error(`unexpected driver failure: ${FULL_DATABASE_URL}`);

    await expect(runTatoebaImportPreflight({
      environment: 'TEST',
      actorUserId: ACTOR_ID,
    }, failingRepository(rawError))).rejects.toMatchObject({
      code: 'TATOEBA_IMPORT_PREFLIGHT_DB_UNAVAILABLE',
      message: 'Tatoeba import preflight database access failed closed.',
    });
  });

  it('sanitizes authentication failures before they reach CLI output', async () => {
    const rawError = new Error(`password authentication failed for user "LEAK_USER" using ${FULL_DATABASE_URL}`);
    const output = { write: jest.fn() };
    const errorOutput = { write: jest.fn() };

    const exitCode = await executeTatoebaPreflightCli([
      '--environment', 'TEST', '--actor-user-id', ACTOR_ID,
    ], output, errorOutput, {
      env: {
        TATOEBA_IMPORT_DATABASE_URL: 'postgresql://readonly:secret@approved.test/congdongngonngu_test?sslmode=require',
        TATOEBA_IMPORT_EXPECTED_DATABASE_HOST: 'approved.test',
        TATOEBA_IMPORT_EXPECTED_DATABASE_NAME: 'congdongngonngu_test',
        TATOEBA_IMPORT_EXPECTED_DATABASE_USER: 'readonly_test',
      },
      createRepository: () => ({
        repository: failingRepository(rawError),
        close: async () => undefined,
      }),
    });

    const diagnostics = errorOutput.write.mock.calls.flat().join('\n');
    expect(exitCode).toBe(2);
    expect(diagnostics).toContain('TATOEBA_IMPORT_PREFLIGHT_DB_UNAVAILABLE');
    expectNoSensitiveValues(diagnostics);
    expect(output.write).not.toHaveBeenCalled();
  });

  it('does not reflect a raw URL supplied as an unsupported CLI argument', async () => {
    const output = { write: jest.fn() };
    const errorOutput = { write: jest.fn() };
    const logSpies = [
      jest.spyOn(console, 'log').mockImplementation(() => undefined),
      jest.spyOn(console, 'warn').mockImplementation(() => undefined),
      jest.spyOn(console, 'error').mockImplementation(() => undefined),
    ];

    try {
      const exitCode = await executeTatoebaPreflightCli(
        [FULL_DATABASE_URL],
        output,
        errorOutput,
      );

      const diagnostics = errorOutput.write.mock.calls.flat().join('\n');
      expect(exitCode).toBe(2);
      expect(diagnostics).toContain('TATOEBA_IMPORT_ENVIRONMENT_INVALID');
      expectNoSensitiveValues(diagnostics);
      expect(output.write).not.toHaveBeenCalled();
      for (const logSpy of logSpies) expect(logSpy).not.toHaveBeenCalled();
    } finally {
      for (const logSpy of logSpies) logSpy.mockRestore();
    }
  });
});
