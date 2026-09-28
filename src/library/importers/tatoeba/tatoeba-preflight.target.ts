import { preflightError } from './tatoeba-preflight.contract';

export type TatoebaPreflightPoolSsl = true | { readonly rejectUnauthorized: true };

export interface TatoebaPreflightDatabaseTarget {
  databaseUrl: string;
  hostname: string;
  expectedDatabaseHost: string;
  expectedDatabaseName: string;
  expectedDatabaseUser: string;
  isRemote: boolean;
  ssl?: TatoebaPreflightPoolSsl;
}

const REMOTE_SSL_MODES = new Set(['require', 'verify-ca', 'verify-full']);
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function normalizeExpectedHost(expectedHost: string): string {
  const normalized = expectedHost.trim().toLowerCase();
  if (
    !normalized
    || normalized !== expectedHost.toLowerCase()
    || normalized.includes('*')
    || normalized.includes('?')
    || normalized.includes('/')
    || normalized.includes('#')
    || normalized.includes('@')
  ) {
    throw preflightError(
      'TATOEBA_IMPORT_DATABASE_HOST_MISMATCH',
      'The connection URL hostname does not match the explicitly expected TEST host.',
    );
  }
  return normalized;
}

function parseDatabaseUrl(databaseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw preflightError(
      'TATOEBA_IMPORT_DATABASE_URL_INVALID',
      'The dedicated TEST database URL is invalid.',
    );
  }

  if ((parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') || !parsed.hostname) {
    throw preflightError(
      'TATOEBA_IMPORT_DATABASE_URL_INVALID',
      'The dedicated TEST database URL must be a PostgreSQL URL with a hostname.',
    );
  }
  return parsed;
}

export function parseTatoebaPreflightDatabaseTarget(
  databaseUrl: string | undefined,
  expectedHost: string | undefined,
  expectedDatabaseName: string | undefined,
  expectedDatabaseUser: string | undefined,
): TatoebaPreflightDatabaseTarget {
  if (!databaseUrl) {
    throw preflightError(
      'TATOEBA_IMPORT_DATABASE_URL_REQUIRED',
      'TATOEBA_IMPORT_DATABASE_URL is required for TEST preflight.',
    );
  }

  const parsedUrl = parseDatabaseUrl(databaseUrl);
  if (!expectedHost) {
    throw preflightError(
      'TATOEBA_IMPORT_EXPECTED_HOST_REQUIRED',
      'TATOEBA_IMPORT_EXPECTED_DATABASE_HOST is required to prove the TEST target.',
    );
  }
  const normalizedExpectedHost = normalizeExpectedHost(expectedHost);
  const hostname = parsedUrl.hostname.toLowerCase();
  if (hostname !== normalizedExpectedHost) {
    throw preflightError(
      'TATOEBA_IMPORT_DATABASE_HOST_MISMATCH',
      'The connection URL hostname does not match the explicitly expected TEST host.',
    );
  }

  if (!expectedDatabaseName || expectedDatabaseName.trim().length === 0) {
    throw preflightError(
      'TATOEBA_IMPORT_EXPECTED_DATABASE_REQUIRED',
      'TATOEBA_IMPORT_EXPECTED_DATABASE_NAME is required to prove the TEST target.',
    );
  }
  if (!expectedDatabaseUser || expectedDatabaseUser.trim().length === 0) {
    throw preflightError(
      'TATOEBA_IMPORT_EXPECTED_DATABASE_USER_REQUIRED',
      'TATOEBA_IMPORT_EXPECTED_DATABASE_USER is required to prove the TEST target.',
    );
  }

  const isRemote = !LOCAL_HOSTNAMES.has(hostname);
  const sslMode = (parsedUrl.searchParams.get('sslmode') ?? '').toLowerCase();
  if (isRemote && !REMOTE_SSL_MODES.has(sslMode)) {
    throw preflightError(
      'TATOEBA_IMPORT_REMOTE_SSL_REQUIRED',
      'Remote TEST preflight requires an encrypted PostgreSQL transport.',
    );
  }

  const ssl = !isRemote
    ? undefined
    : sslMode === 'require'
      ? true
      : { rejectUnauthorized: true } as const;

  return {
    databaseUrl,
    hostname,
    expectedDatabaseHost: normalizedExpectedHost,
    expectedDatabaseName,
    expectedDatabaseUser,
    isRemote,
    ssl,
  };
}
