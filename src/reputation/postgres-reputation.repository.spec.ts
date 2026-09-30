import { describe, expect, it, jest } from '@jest/globals';
import type { Pool } from 'pg';
import {
  PostgresReputationLedgerRepository,
  type AppendReputationLedgerEntryInput,
} from './reputation.repository';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const SOURCE_ID = '00000000-0000-4000-8000-000000000002';
const ENTRY_ID = '00000000-0000-4000-8000-000000000003';
const CREATED_AT = new Date('2026-09-30T10:00:00.000Z');
type QueryFn = (...args: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

describe('PostgresReputationLedgerRepository', () => {
  it('inserts ledger facts with parameterized enum and UUID boundaries', async () => {
    const query = jest.fn<QueryFn>().mockResolvedValue({ rows: [row()] });
    const repository = new PostgresReputationLedgerRepository({ query } as unknown as Pool);

    const result = await repository.append(input());

    expect(result).toMatchObject({ created: true, entry: { id: ENTRY_ID, delta: 8 } });
    expect(query.mock.calls[0][0]).toContain('ON CONFLICT (idempotency_key) DO NOTHING');
    expect(query.mock.calls[0][0]).toContain('$2::reputation_system');
    expect(query.mock.calls[0][0]).toContain('$4::uuid');
    expect(query.mock.calls[0][1]).toEqual([
      USER_ID,
      'community_reputation',
      'CORRECTION_ACCEPTED',
      SOURCE_ID,
      8,
      'Accepted language correction',
      'community-reputation-v1',
      'reputation:CORRECTION_ACCEPTED:source-1',
      null,
      CREATED_AT,
    ]);
  });

  it('loads the existing row after an idempotent insert conflict', async () => {
    const query = jest.fn<QueryFn>()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row()] });
    const repository = new PostgresReputationLedgerRepository({ query } as unknown as Pool);

    const result = await repository.append(input());

    expect(result.created).toBe(false);
    expect(result.entry.id).toBe(ENTRY_ID);
    expect(query.mock.calls[1][0]).toContain('WHERE idempotency_key = $1');
    expect(query.mock.calls[1][1]).toEqual(['reputation:CORRECTION_ACCEPTED:source-1']);
  });

  it('maps a database reversal uniqueness failure to a safe domain conflict', async () => {
    const query = jest.fn<QueryFn>().mockRejectedValue({
      code: '23505',
      constraint: 'reputation_ledger_reversal_unique_idx',
    });
    const repository = new PostgresReputationLedgerRepository({ query } as unknown as Pool);

    await expect(repository.append({
      ...input(),
      delta: -8,
      reason: 'Reversed after moderation',
      idempotencyKey: 'reversal:entry-1',
      reversalOfEntryId: ENTRY_ID,
    })).rejects.toMatchObject({ code: 'REPUTATION_REVERSAL_EXISTS' });
  });

  it('keeps user and cursor values parameterized when listing private detail', async () => {
    const query = jest.fn<QueryFn>().mockResolvedValue({ rows: [] });
    const repository = new PostgresReputationLedgerRepository({ query } as unknown as Pool);

    await repository.listByUser({
      userId: USER_ID,
      system: 'community_reputation',
      before: { id: ENTRY_ID, createdAt: CREATED_AT },
      limit: 20,
    });

    expect(query.mock.calls[0][0]).not.toContain(USER_ID);
    expect(query.mock.calls[0][1]).toEqual([
      USER_ID,
      'community_reputation',
      20,
      CREATED_AT,
      ENTRY_ID,
    ]);
  });
});

function input(): AppendReputationLedgerEntryInput {
  return {
    userId: USER_ID,
    system: 'community_reputation',
    sourceType: 'CORRECTION_ACCEPTED',
    sourceId: SOURCE_ID,
    delta: 8,
    reason: 'Accepted language correction',
    ruleVersion: 'community-reputation-v1',
    idempotencyKey: 'reputation:CORRECTION_ACCEPTED:source-1',
    reversalOfEntryId: null,
    createdAt: CREATED_AT,
  };
}

function row(): Record<string, unknown> {
  return {
    id: ENTRY_ID,
    user_id: USER_ID,
    system: 'community_reputation',
    source_type: 'CORRECTION_ACCEPTED',
    source_id: SOURCE_ID,
    delta: 8,
    reason: 'Accepted language correction',
    rule_version: 'community-reputation-v1',
    idempotency_key: 'reputation:CORRECTION_ACCEPTED:source-1',
    reversal_of_entry_id: null,
    created_at: CREATED_AT.toISOString(),
  };
}
