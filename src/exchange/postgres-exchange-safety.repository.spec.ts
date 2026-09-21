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
      if (sql.includes('DELETE FROM language_exchange_connections')) {
        return { rows: [{ id: 'connection-1', requester_user_id: 'requester-1' }], rowCount: 1 };
      }
      throw new Error('Unexpected SQL: ' + sql);
    });
    const connect = jest.fn<() => Promise<PoolClient>>().mockResolvedValue(client);
    const repository = new PostgresExchangeSafetyRepository({ connect } as unknown as Pool);

    await expect(repository.blockUser(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    )).resolves.toMatchObject({
      outcome: 'CREATED',
      relationshipRemoval: 'ATOMIC',
      removedConnectionId: 'connection-1',
      removedRequesterUserId: 'requester-1',
    });

    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toContain('pg_advisory_xact_lock');
    expect(calls.some((sql) => sql.includes('INSERT INTO language_exchange_blocks'))).toBe(true);
    expect(calls.find((sql) => sql.includes('DELETE FROM language_exchange_connections')))
      .toContain('RETURNING id, requester_user_id');
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

  it('uses active report state for idempotency and allows a new incident after resolution', async () => {
    const states = new Map<string, 'OPEN' | 'IN_REVIEW' | 'RESOLVED' | 'DISMISSED'>();
    const pool = {
      query: jest.fn(async (sql: string, values: unknown[]) => {
        expect(sql).toContain("WHERE state IN ('OPEN'::exchange_report_state, 'IN_REVIEW'::exchange_report_state)");
        const key = values.slice(0, 3).join(':');
        const state = states.get(key);
        if (state === 'OPEN' || state === 'IN_REVIEW') return { rows: [], rowCount: 0 };
        states.set(key, 'OPEN');
        return { rows: [{ id: 'report-' + states.size }], rowCount: 1 };
      }),
    } as unknown as Pool;
    const repository = new PostgresExchangeSafetyRepository(pool);
    const input = {
      reporterUserId: 'reporter-1',
      targetUserId: 'target-1',
      category: 'SAFETY_CONCERN' as const,
      context: 'context',
    };

    await expect(repository.submitReport(input)).resolves.toEqual({ duplicate: false });
    await expect(repository.submitReport(input)).resolves.toEqual({ duplicate: true });
    states.set('reporter-1:target-1:SAFETY_CONCERN', 'IN_REVIEW');
    await expect(repository.submitReport(input)).resolves.toEqual({ duplicate: true });
    states.set('reporter-1:target-1:SAFETY_CONCERN', 'RESOLVED');
    await expect(repository.submitReport(input)).resolves.toEqual({ duplicate: false });
    states.set('reporter-1:target-1:SAFETY_CONCERN', 'DISMISSED');
    await expect(repository.submitReport(input)).resolves.toEqual({ duplicate: false });
    await expect(repository.submitReport({ ...input, category: 'OTHER' })).resolves.toEqual({ duplicate: false });
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
