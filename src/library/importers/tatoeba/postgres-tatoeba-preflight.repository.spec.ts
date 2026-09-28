import type { PoolClient } from 'pg';
import { describe, expect, it, jest } from '@jest/globals';

import {
  PREFLIGHT_SQL,
  PostgresTatoebaImportPreflightRepository,
} from './postgres-tatoeba-preflight.repository';

const ACTOR_ID = '00000000-0000-4000-8000-000000000001';
type QueryFn = (...args: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

function fakeClient(query: QueryFn): PoolClient {
  return {
    query,
    release: jest.fn(),
  } as unknown as PoolClient;
}

describe('PostgresTatoebaImportPreflightRepository', () => {
  it('has a read-only SQL surface with no mutation statements', () => {
    const sql = Object.values(PREFLIGHT_SQL).join('\n');
    expect(sql).toMatch(/BEGIN READ ONLY/);
    expect(sql).toMatch(/SET LOCAL statement_timeout/);
    expect(sql).toMatch(/SELECT/);
    expect(sql).toMatch(/COMMIT/);
    expect(sql).toMatch(/ROLLBACK/);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|CREATE|DROP)\b/i);
  });

  it('runs target identification, actor/license reads, and commit inside READ ONLY transaction', async () => {
    const query = jest.fn<QueryFn>().mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ database_name: 'congdongngonngu_test', database_user: 'readonly_test', server_version: 'PostgreSQL 16' }] })
      .mockResolvedValueOnce({ rows: [{ user_id: ACTOR_ID, status: 'ACTIVE', roles: ['ADMIN'] }] })
      .mockResolvedValueOnce({ rows: [{ license_key: 'CC_BY_2_0_FR', display_name: 'CC BY 2.0 France', canonical_url: 'https://creativecommons.org/licenses/by/2.0/fr/', attribution_required: true, redistribution_allowed: true, active: true }] })
      .mockResolvedValueOnce({ rows: [{ license_key: 'CC0_1_0', display_name: 'CC0 1.0', canonical_url: 'https://creativecommons.org/publicdomain/zero/1.0/', attribution_required: false, redistribution_allowed: true, active: true }] })
      .mockResolvedValueOnce({ rows: [] });
    const client = fakeClient(query);
    const pool = { connect: async () => client };
    const repository = new PostgresTatoebaImportPreflightRepository(
      pool,
      'congdongngonngu_test',
      'readonly_test',
    );

    await repository.withReadOnlyTransaction(async (transaction) => {
      await transaction.findImportActor(ACTOR_ID);
      await transaction.findLicense('CC_BY_2_0_FR');
      await transaction.findLicense('CC0_1_0');
    });

    expect(query.mock.calls[0]).toEqual([PREFLIGHT_SQL.begin]);
    expect(query.mock.calls[1]).toEqual([PREFLIGHT_SQL.statementTimeout]);
    expect(query.mock.calls[2]).toEqual([PREFLIGHT_SQL.target]);
    expect(query.mock.calls[3]).toEqual([PREFLIGHT_SQL.actor, [ACTOR_ID]]);
    expect(query.mock.calls[4]).toEqual([PREFLIGHT_SQL.license, ['CC_BY_2_0_FR']]);
    expect(query.mock.calls[5]).toEqual([PREFLIGHT_SQL.license, ['CC0_1_0']]);
    expect(query.mock.calls[6]).toEqual([PREFLIGHT_SQL.commit]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and releases the client when a target or read fails', async () => {
    const query = jest.fn<QueryFn>().mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('connection dropped'));
    const client = fakeClient(query);
    const pool = { connect: async () => client };
    const repository = new PostgresTatoebaImportPreflightRepository(
      pool,
      'congdongngonngu_test',
      'readonly_test',
    );

    await expect(repository.withReadOnlyTransaction(async (transaction) => {
      await transaction.findImportActor(ACTOR_ID);
    })).rejects.toMatchObject({
      code: 'TATOEBA_IMPORT_PREFLIGHT_DB_UNAVAILABLE',
      message: 'Tatoeba import preflight database access failed closed.',
    });
    expect(query).toHaveBeenLastCalledWith(PREFLIGHT_SQL.rollback);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('sanitizes connection acquisition failures at the repository boundary', async () => {
    const rawError = new Error('connect failed: postgresql://LEAK_USER:LEAK_PASSWORD@leak.test/db?token=LEAK_QUERY_SECRET');
    const pool = {
      connect: async () => {
        throw rawError;
      },
    };
    const repository = new PostgresTatoebaImportPreflightRepository(
      pool,
      'congdongngonngu_test',
      'readonly_test',
    );

    await expect(repository.withReadOnlyTransaction(async () => undefined))
      .rejects.toMatchObject({
        code: 'TATOEBA_IMPORT_PREFLIGHT_DB_UNAVAILABLE',
        message: 'Tatoeba import preflight database access failed closed.',
      });
  });

  it('does not accept an unexpected database target', async () => {
    const query = jest.fn<QueryFn>().mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ database_name: 'production', database_user: 'app', server_version: 'PostgreSQL 16' }] });
    const client = fakeClient(query);
    const pool = { connect: async () => client };
    const repository = new PostgresTatoebaImportPreflightRepository(
      pool,
      'congdongngonngu_test',
      'readonly_test',
    );

    await expect(repository.withReadOnlyTransaction(async () => undefined))
      .rejects.toMatchObject({ code: 'TATOEBA_IMPORT_DATABASE_NAME_MISMATCH' });
    expect(query).toHaveBeenLastCalledWith(PREFLIGHT_SQL.rollback);
    expect(query.mock.calls).not.toContainEqual([PREFLIGHT_SQL.actor, [ACTOR_ID]]);
  });

  it('rejects an unexpected database user before actor/license reads', async () => {
    const query = jest.fn<QueryFn>().mockResolvedValue({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ database_name: 'congdongngonngu_test', database_user: 'app', server_version: 'PostgreSQL 16' }] });
    const client = fakeClient(query);
    const pool = { connect: async () => client };
    const repository = new PostgresTatoebaImportPreflightRepository(
      pool,
      'congdongngonngu_test',
      'readonly_test',
    );

    await expect(repository.withReadOnlyTransaction(async (transaction) => {
      await transaction.findImportActor(ACTOR_ID);
    })).rejects.toMatchObject({ code: 'TATOEBA_IMPORT_DATABASE_USER_MISMATCH' });
    expect(query).toHaveBeenLastCalledWith(PREFLIGHT_SQL.rollback);
    expect(query.mock.calls).not.toContainEqual([PREFLIGHT_SQL.actor, [ACTOR_ID]]);
  });
});
