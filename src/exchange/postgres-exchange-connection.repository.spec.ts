import { describe, expect, it, jest } from '@jest/globals';
import type { Pool, PoolClient } from 'pg';
import { PostgresExchangeConnectionRepository } from './postgres-exchange-connection.repository';

describe('PostgresExchangeConnectionRepository', () => {
  it('retries a unique pair race and converges the second read to connected', async () => {
    const calls: string[] = [];
    const pendingRow = connectionRow('PENDING');
    const connectedRow = connectionRow('CONNECTED');
    const firstClient = fakeClient(async (sql: string) => {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('FOR UPDATE')) return { rows: [] };
      if (sql.includes('INSERT INTO language_exchange_connections')) {
        const error = new Error('duplicate pair') as Error & { code: string };
        error.code = '23505';
        throw error;
      }
      throw new Error('Unexpected first-attempt SQL: ' + sql);
    });
    const secondClient = fakeClient(async (sql: string) => {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('FOR UPDATE')) return { rows: [pendingRow] };
      if (sql.includes('UPDATE language_exchange_connections')) return { rows: [connectedRow] };
      throw new Error('Unexpected retry SQL: ' + sql);
    });
    const connect = jest.fn<() => Promise<PoolClient>>();
    connect.mockResolvedValueOnce(firstClient).mockResolvedValueOnce(secondClient);
    const pool = { connect } as unknown as Pool;
    const repository = new PostgresExchangeConnectionRepository(pool);

    const result = await repository.requestConnection(
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001',
    );

    expect(result).toMatchObject({ outcome: 'CONNECTED', record: { status: 'CONNECTED' } });
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(calls.filter((sql) => sql === 'BEGIN')).toHaveLength(2);
    expect(calls.filter((sql) => sql === 'ROLLBACK')).toHaveLength(1);
    expect(calls.filter((sql) => sql.includes('FOR UPDATE'))).toHaveLength(2);
    expect(calls.filter((sql) => sql.includes('pg_advisory_xact_lock'))).toHaveLength(2);
    expect(calls.filter((sql) => sql.includes('INSERT INTO language_exchange_connections'))).toHaveLength(1);
    expect(calls.filter((sql) => sql.includes('UPDATE language_exchange_connections'))).toHaveLength(1);
    expect(calls.every((sql) => !sql.includes('SELECT *'))).toBe(true);
    expect(calls.filter((sql) => sql.includes('FOR UPDATE'))[0]).toEqual(expect.stringContaining('LEAST($1::uuid, $2::uuid)'));
    expect(calls.filter((sql) => sql.includes('FOR UPDATE'))[0]).toEqual(expect.stringContaining('GREATEST($1::uuid, $2::uuid)'));
    expect(firstClient.release).toHaveBeenCalledTimes(1);
    expect(secondClient.release).toHaveBeenCalledTimes(1);
  });
});

function fakeClient(query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>): PoolClient {
  return {
    query: jest.fn(query),
    release: jest.fn(),
  } as unknown as PoolClient;
}

function connectionRow(status: 'PENDING' | 'CONNECTED'): Record<string, unknown> {
  return {
    id: '00000000-0000-4000-8000-000000000010',
    participant_a_id: '00000000-0000-4000-8000-000000000001',
    participant_b_id: '00000000-0000-4000-8000-000000000002',
    requester_id: '00000000-0000-4000-8000-000000000001',
    status,
    created_at: new Date('2026-09-18T00:00:00.000Z'),
    updated_at: new Date('2026-09-18T00:00:00.000Z'),
  };
}
