import { describe, expect, it, jest } from '@jest/globals';
import type { Pool, PoolClient } from 'pg';
import { PostgresExchangeSafetyRepository } from './postgres-exchange-safety.repository';

describe('PostgresExchangeSafetyRepository', () => {
  it('persists a directional block and removes the canonical relationship in one transaction', async () => {
    const calls: string[] = [];
    const client = fakeClient(async (sql: string) => {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO language_exchange_blocks')) return { rows: [{ blocker_user_id: 'first' }], rowCount: 1 };
      if (sql.includes('DELETE FROM language_exchange_connections')) return { rows: [], rowCount: 1 };
      throw new Error('Unexpected SQL: ' + sql);
    });
    const connect = jest.fn<() => Promise<PoolClient>>().mockResolvedValue(client);
    const repository = new PostgresExchangeSafetyRepository({ connect } as unknown as Pool);

    await expect(repository.blockUser(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    )).resolves.toMatchObject({ outcome: 'CREATED' });

    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toContain('pg_advisory_xact_lock');
    expect(calls.some((sql) => sql.includes('INSERT INTO language_exchange_blocks'))).toBe(true);
    expect(calls.some((sql) => sql.includes('DELETE FROM language_exchange_connections'))).toBe(true);
    expect(calls.at(-1)).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('removes only the actor-owned direction during unblock', async () => {
    const calls: string[] = [];
    const client = fakeClient(async (sql: string) => {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
      if (sql.includes('DELETE FROM language_exchange_blocks')) return { rows: [], rowCount: 0 };
      throw new Error('Unexpected SQL: ' + sql);
    });
    const connect = jest.fn<() => Promise<PoolClient>>().mockResolvedValue(client);
    const repository = new PostgresExchangeSafetyRepository({ connect } as unknown as Pool);

    await expect(repository.unblockUser(
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001',
    )).resolves.toMatchObject({ outcome: 'NOT_BLOCKED' });
    expect(calls.find((sql) => sql.includes('DELETE FROM language_exchange_blocks'))).toContain('blocker_user_id = $1::uuid');
  });
});

function fakeClient(
  query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }>,
): PoolClient {
  return {
    query: jest.fn(query),
    release: jest.fn(),
  } as unknown as PoolClient;
}
