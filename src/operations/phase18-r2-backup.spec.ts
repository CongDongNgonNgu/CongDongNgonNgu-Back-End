import {
  buildBackupMetadata,
  buildR2ObjectKey,
  sanitizeOperationalError,
  sha256Hex,
  validateR2Configuration,
} from './phase18-r2-backup';

describe('Phase 18 R2 backup boundaries', () => {
  const validEnvironment = {
    NODE_ENV: 'development',
    STORAGE_PROVIDER: 'r2',
    STORAGE_API_URL: 'https://account-id.r2.cloudflarestorage.com',
    STORAGE_ACCESS_KEY_ID: 'access-key',
    STORAGE_SECRET_ACCESS_KEY: 'secret-key',
    STORAGE_BUCKET: 'congdongngonngu',
  };

  it('accepts only a non-production R2 S3 configuration', () => {
    expect(validateR2Configuration(validEnvironment)).toMatchObject({
      endpoint: validEnvironment.STORAGE_API_URL,
      bucket: validEnvironment.STORAGE_BUCKET,
      region: 'auto',
    });
    expect(() => validateR2Configuration({ ...validEnvironment, NODE_ENV: 'production' }))
      .toThrow('TEST/UAT only');
    expect(() => validateR2Configuration({ ...validEnvironment, STORAGE_PROVIDER: 'disabled' }))
      .toThrow('STORAGE_PROVIDER=r2 is required');
    expect(() => validateR2Configuration({ ...validEnvironment, STORAGE_API_URL: 'https://storage.example.test' }))
      .toThrow('R2 S3 endpoint');
  });

  it('rejects missing storage credentials without exposing values', () => {
    expect(() => validateR2Configuration({ ...validEnvironment, STORAGE_SECRET_ACCESS_KEY: '' }))
      .toThrow('STORAGE_SECRET_ACCESS_KEY is required');
    expect(() => validateR2Configuration({ ...validEnvironment, STORAGE_BUCKET: undefined }))
      .toThrow('STORAGE_BUCKET is required');
  });

  it('keeps verification and backup objects in private Phase 18 namespaces', () => {
    const verification = buildR2ObjectKey('verification', new Date('2026-10-03T12:34:56.000Z'), 'abc123');
    const backup = buildR2ObjectKey('backup', new Date('2026-10-03T12:34:56.000Z'), 'abc123');

    expect(verification).toBe('phase18-verification/abc123/probe.bin');
    expect(backup).toBe('backups/uat/database/2026/10/03/congdongngonngu-uat-20261003T123456Z-abc123.dump');
    expect(verification).not.toMatch(/@|password|secret|token/i);
    expect(backup).not.toMatch(/@|password|secret|token/i);
  });

  it('calculates deterministic SHA-256 and sanitized metadata', () => {
    const bytes = Buffer.from('phase18-r2-test');
    const digest = sha256Hex(bytes);
    expect(digest).toBe('258c334cf3650b7c8224c938813e014e68103353a8ac6f2d0af5c879bbf0a8de');
    expect(buildBackupMetadata({
      sha256: digest,
      sizeBytes: bytes.length,
      createdAt: '2026-10-03T12:34:56.000Z',
      pgDumpVersion: 'pg_dump (PostgreSQL) 18.6',
      migrationRows: 26,
    })).toEqual({
      format: 'phase18-uat-postgresql-backup-v1',
      sha256: digest,
      sizeBytes: bytes.length,
      createdAt: '2026-10-03T12:34:56.000Z',
      pgDumpVersion: 'pg_dump (PostgreSQL) 18.6',
      migrationRows: 26,
    });
  });

  it('does not expose raw provider or database error details', () => {
    expect(sanitizeOperationalError(
      new Error('postgresql://example.test/db?query=redacted'),
      'R2 operation failed',
    )).toBe('R2 operation failed');
  });
});
