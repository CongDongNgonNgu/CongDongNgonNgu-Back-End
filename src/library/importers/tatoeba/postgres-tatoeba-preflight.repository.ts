import { Pool } from 'pg';
import type { PoolClient } from 'pg';

import {
  preflightError,
} from './tatoeba-preflight.contract';
import {
  TATOEBA_IMPORT_EXPECTED_DATABASE_ENV,
  TATOEBA_IMPORT_EXPECTED_DATABASE_USER_ENV,
  TATOEBA_PREFLIGHT_CONNECTION_TIMEOUT_MS,
  TATOEBA_PREFLIGHT_STATEMENT_TIMEOUT_MS,
  type TatoebaImportActorRecord,
  type TatoebaImportLicenseRecord,
  type TatoebaImportPreflightRepository,
  type TatoebaImportPreflightTransaction,
  type TatoebaLibraryLicenseKey,
} from './tatoeba-preflight.types';
import type { TatoebaPreflightDatabaseTarget } from './tatoeba-preflight.target';

export const PREFLIGHT_SQL = {
  begin: 'BEGIN READ ONLY',
  statementTimeout: `SET LOCAL statement_timeout = ${TATOEBA_PREFLIGHT_STATEMENT_TIMEOUT_MS}`,
  target: `SELECT current_database() AS database_name,
      current_user AS database_user,
      version() AS server_version`,
  actor: `SELECT u.id AS user_id,
      u.status::text AS status,
      COALESCE(
        array_agg(ur.role_key::text ORDER BY ur.role_key::text)
          FILTER (WHERE ur.role_key IS NOT NULL),
        ARRAY[]::text[]
      ) AS roles
    FROM users AS u
    LEFT JOIN user_roles AS ur ON ur.user_id = u.id
    WHERE u.id = $1::uuid
    GROUP BY u.id, u.status`,
  license: `SELECT license_key,
      display_name,
      canonical_url,
      attribution_required,
      redistribution_allowed,
      derivative_constraints,
      active
    FROM library_licenses
    WHERE license_key = $1`,
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
} as const;

interface QueryablePool {
  connect(): Promise<PoolClient>;
}

function readRows(result: { rows: Array<Record<string, unknown>> }): Array<Record<string, unknown>> {
  return Array.isArray(result.rows) ? result.rows : [];
}

class PostgresTatoebaImportPreflightTransaction implements TatoebaImportPreflightTransaction {
  constructor(private readonly client: PoolClient) {}

  async findImportActor(userId: string): Promise<TatoebaImportActorRecord | null> {
    const result = await this.client.query(PREFLIGHT_SQL.actor, [userId]);
    const row = readRows(result as { rows: Array<Record<string, unknown>> })[0];
    if (!row) return null;
    const roles = Array.isArray(row.roles) ? row.roles.map((role) => String(role)) : [];
    return {
      userId: String(row.user_id),
      status: String(row.status),
      roles,
    };
  }

  async findLicense(licenseKey: TatoebaLibraryLicenseKey): Promise<TatoebaImportLicenseRecord | null> {
    const result = await this.client.query(PREFLIGHT_SQL.license, [licenseKey]);
    const row = readRows(result as { rows: Array<Record<string, unknown>> })[0];
    if (!row) return null;
    return {
      licenseKey: String(row.license_key),
      displayName: String(row.display_name),
      canonicalUrl: String(row.canonical_url),
      attributionRequired: row.attribution_required === true,
      redistributionAllowed: row.redistribution_allowed === null || row.redistribution_allowed === undefined
        ? null
        : row.redistribution_allowed === true,
      active: row.active === true,
      derivativeConstraints: row.derivative_constraints === null || row.derivative_constraints === undefined
        ? null
        : String(row.derivative_constraints),
    };
  }
}

export class PostgresTatoebaImportPreflightRepository implements TatoebaImportPreflightRepository {
  constructor(
    private readonly pool: QueryablePool,
    private readonly expectedDatabaseName: string,
    private readonly expectedDatabaseUser: string,
  ) {}

  async withReadOnlyTransaction<T>(
    callback: (transaction: TatoebaImportPreflightTransaction) => Promise<T>,
  ): Promise<T> {
    if (!this.expectedDatabaseName) {
      throw preflightError(
        'TATOEBA_IMPORT_EXPECTED_DATABASE_REQUIRED',
        `${TATOEBA_IMPORT_EXPECTED_DATABASE_ENV} is required for TEST target verification.`,
      );
    }
    if (!this.expectedDatabaseUser) {
      throw preflightError(
        'TATOEBA_IMPORT_EXPECTED_DATABASE_USER_REQUIRED',
        `${TATOEBA_IMPORT_EXPECTED_DATABASE_USER_ENV} is required for TEST target verification.`,
      );
    }

    const client = await this.pool.connect();
    let transactionStarted = false;
    try {
      await client.query(PREFLIGHT_SQL.begin);
      transactionStarted = true;
      await client.query(PREFLIGHT_SQL.statementTimeout);

      const targetResult = await client.query(PREFLIGHT_SQL.target);
      const targetRow = readRows(targetResult as { rows: Array<Record<string, unknown>> })[0];
      if (String(targetRow?.database_name ?? '') !== this.expectedDatabaseName) {
        throw preflightError(
          'TATOEBA_IMPORT_DATABASE_NAME_MISMATCH',
          'The connected database name is not the explicitly expected TEST database.',
        );
      }
      if (String(targetRow?.database_user ?? '') !== this.expectedDatabaseUser) {
        throw preflightError(
          'TATOEBA_IMPORT_DATABASE_USER_MISMATCH',
          'The connected database user is not the explicitly expected TEST user.',
        );
      }

      const transaction = new PostgresTatoebaImportPreflightTransaction(client);
      const result = await callback(transaction);
      await client.query(PREFLIGHT_SQL.commit);
      return result;
    } catch (error) {
      if (transactionStarted) await client.query(PREFLIGHT_SQL.rollback).catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export interface TatoebaPreflightRepositoryHandle {
  repository: TatoebaImportPreflightRepository;
  close(): Promise<void>;
}

export function createPostgresTatoebaImportPreflightRepository(
  target: TatoebaPreflightDatabaseTarget,
): TatoebaPreflightRepositoryHandle {
  const pool = new Pool({
    connectionString: target.databaseUrl,
    max: 1,
    connectionTimeoutMillis: TATOEBA_PREFLIGHT_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: TATOEBA_PREFLIGHT_CONNECTION_TIMEOUT_MS,
    ...(target.ssl === undefined ? {} : { ssl: target.ssl }),
  });
  return {
    repository: new PostgresTatoebaImportPreflightRepository(
      pool,
      target.expectedDatabaseName,
      target.expectedDatabaseUser,
    ),
    close: () => pool.end(),
  };
}
