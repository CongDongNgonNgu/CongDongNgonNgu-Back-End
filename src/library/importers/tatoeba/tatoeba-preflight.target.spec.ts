import { describe, expect, it } from '@jest/globals';

import { parseTatoebaPreflightDatabaseTarget } from './tatoeba-preflight.target';

const BASE_URL = 'postgresql://readonly:secret@test.db.example/congdongngonngu_test';

describe('Tatoeba preflight database target validation', () => {
  it('requires exact host, database name, and database user configuration', () => {
    expect(() => parseTatoebaPreflightDatabaseTarget(
      `${BASE_URL}?sslmode=require`,
      undefined,
      'congdongngonngu_test',
      'readonly_test',
    )).toThrow(expect.objectContaining({ code: 'TATOEBA_IMPORT_EXPECTED_HOST_REQUIRED' }));

    expect(() => parseTatoebaPreflightDatabaseTarget(
      `${BASE_URL}?sslmode=require`,
      'other.example',
      'congdongngonngu_test',
      'readonly_test',
    )).toThrow(expect.objectContaining({ code: 'TATOEBA_IMPORT_DATABASE_HOST_MISMATCH' }));

    expect(() => parseTatoebaPreflightDatabaseTarget(
      `${BASE_URL}?sslmode=require`,
      'test.db.example',
      undefined,
      'readonly_test',
    )).toThrow(expect.objectContaining({ code: 'TATOEBA_IMPORT_EXPECTED_DATABASE_REQUIRED' }));

    expect(() => parseTatoebaPreflightDatabaseTarget(
      `${BASE_URL}?sslmode=require`,
      'test.db.example',
      'congdongngonngu_test',
      undefined,
    )).toThrow(expect.objectContaining({ code: 'TATOEBA_IMPORT_EXPECTED_DATABASE_USER_REQUIRED' }));
  });

  it('uses URL parsing and rejects malformed or non-PostgreSQL URLs', () => {
    expect(() => parseTatoebaPreflightDatabaseTarget(
      'not a URL', 'test.db.example', 'congdongngonngu_test', 'readonly_test',
    )).toThrow(expect.objectContaining({ code: 'TATOEBA_IMPORT_DATABASE_URL_INVALID' }));
    expect(() => parseTatoebaPreflightDatabaseTarget(
      'https://test.db.example/db', 'test.db.example', 'congdongngonngu_test', 'readonly_test',
    )).toThrow(expect.objectContaining({ code: 'TATOEBA_IMPORT_DATABASE_URL_INVALID' }));
  });

  it('normalizes host casing but does not accept a suffix or wildcard match', () => {
    const target = parseTatoebaPreflightDatabaseTarget(
      'postgresql://test.db.example/congdongngonngu_test?sslmode=require',
      'TEST.DB.EXAMPLE',
      'congdongngonngu_test',
      'readonly_test',
    );
    expect(target.hostname).toBe('test.db.example');
    expect(target.expectedDatabaseHost).toBe('test.db.example');

    expect(() => parseTatoebaPreflightDatabaseTarget(
      `${BASE_URL}?sslmode=require`, 'db.example', 'congdongngonngu_test', 'readonly_test',
    )).toThrow(expect.objectContaining({ code: 'TATOEBA_IMPORT_DATABASE_HOST_MISMATCH' }));
    expect(() => parseTatoebaPreflightDatabaseTarget(
      `${BASE_URL}?sslmode=require`, '*.db.example', 'congdongngonngu_test', 'readonly_test',
    )).toThrow(expect.objectContaining({ code: 'TATOEBA_IMPORT_DATABASE_HOST_MISMATCH' }));
  });

  it('requires encrypted transport for remote TEST targets and never includes URL secrets in errors', () => {
    expect(() => parseTatoebaPreflightDatabaseTarget(
      BASE_URL, 'test.db.example', 'congdongngonngu_test', 'readonly_test',
    )).toThrow(expect.objectContaining({ code: 'TATOEBA_IMPORT_REMOTE_SSL_REQUIRED' }));
    expect(() => parseTatoebaPreflightDatabaseTarget(
      `${BASE_URL}?sslmode=disable`, 'test.db.example', 'congdongngonngu_test', 'readonly_test',
    )).toThrow(expect.objectContaining({ code: 'TATOEBA_IMPORT_REMOTE_SSL_REQUIRED' }));

    const error = (() => {
      try {
        parseTatoebaPreflightDatabaseTarget(
          `${BASE_URL}?sslmode=disable`, 'test.db.example', 'congdongngonngu_test', 'readonly_test',
        );
        return null;
      } catch (caught) {
        return caught as Error;
      }
    })();
    expect(error?.message).not.toContain('secret');
    expect(error?.message).not.toContain(BASE_URL);
  });

  it('selects encrypted pool settings without exposing target metadata', () => {
    const requireTarget = parseTatoebaPreflightDatabaseTarget(
      `${BASE_URL}?sslmode=require`, 'test.db.example', 'congdongngonngu_test', 'readonly_test',
    );
    expect(requireTarget.ssl).toBe(true);
    expect(requireTarget.isRemote).toBe(true);

    const verifyFullTarget = parseTatoebaPreflightDatabaseTarget(
      `${BASE_URL}?sslmode=verify-full`, 'test.db.example', 'congdongngonngu_test', 'readonly_test',
    );
    expect(verifyFullTarget.ssl).toEqual({ rejectUnauthorized: true });
  });
});
