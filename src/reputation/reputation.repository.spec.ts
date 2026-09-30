import { describe, expect, it } from '@jest/globals';
import {
  InMemoryReputationLedgerRepository,
  ReputationRepositoryConflictError,
} from './reputation.repository';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const SOURCE_ID = '00000000-0000-4000-8000-000000000002';
const CREATED_AT = new Date('2026-09-30T10:00:00.000Z');

describe('InMemoryReputationLedgerRepository', () => {
  it('keeps learning XP and community reputation balances independent', async () => {
    const repository = new InMemoryReputationLedgerRepository();

    await repository.append({
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
    });
    await repository.append({
      userId: USER_ID,
      system: 'learning_xp',
      sourceType: 'PRACTICE_COMPLETED',
      sourceId: SOURCE_ID,
      delta: 20,
      reason: 'Completed practice',
      ruleVersion: 'learning-xp-v1',
      idempotencyKey: 'learning:PRACTICE_COMPLETED:source-1',
      reversalOfEntryId: null,
      createdAt: CREATED_AT,
    });

    await expect(repository.getBalance(USER_ID, 'community_reputation')).resolves.toBe(8);
    await expect(repository.getBalance(USER_ID, 'learning_xp')).resolves.toBe(20);
  });

  it('converges identical event replay and rejects a conflicting idempotency reuse', async () => {
    const repository = new InMemoryReputationLedgerRepository();
    const input = contributionInput();

    const first = await repository.append(input);
    const retry = await repository.append({ ...input, createdAt: new Date('2026-09-30T11:00:00.000Z') });

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.entry.id).toBe(first.entry.id);
    await expect(repository.getBalance(USER_ID, 'community_reputation')).resolves.toBe(8);

    await expect(repository.append({ ...input, delta: 12 })).rejects.toMatchObject({
      code: 'REPUTATION_IDEMPOTENCY_CONFLICT',
    });
  });

  it('appends a compensating reversal without deleting the original entry', async () => {
    const repository = new InMemoryReputationLedgerRepository();
    const original = await repository.append(contributionInput());

    const reversal = await repository.append({
      ...contributionInput(),
      delta: -8,
      reason: 'Reversed after source moderation',
      idempotencyKey: `reversal:${original.entry.id}`,
      reversalOfEntryId: original.entry.id,
    });

    expect(reversal.created).toBe(true);
    expect(reversal.entry.reversalOfEntryId).toBe(original.entry.id);
    await expect(repository.findById(original.entry.id)).resolves.toEqual(original.entry);
    await expect(repository.findByReversalOfEntryId(original.entry.id)).resolves.toEqual(reversal.entry);
    await expect(repository.getBalance(USER_ID, 'community_reputation')).resolves.toBe(0);
    await expect(repository.listByUser({ userId: USER_ID, limit: 10 })).resolves.toHaveLength(2);

    await expect(repository.append({
      ...contributionInput(),
      delta: -8,
      reason: 'Second reversal attempt',
      idempotencyKey: `reversal:duplicate:${original.entry.id}`,
      reversalOfEntryId: original.entry.id,
    })).rejects.toMatchObject({ code: 'REPUTATION_REVERSAL_EXISTS' });
  });

  it('rejects invalid ledger facts before they can become balance state', async () => {
    const repository = new InMemoryReputationLedgerRepository();

    await expect(repository.append({
      ...contributionInput(),
      delta: 0,
    })).rejects.toBeInstanceOf(ReputationRepositoryConflictError);
    await expect(repository.append({
      ...contributionInput(),
      idempotencyKey: ' ',
    })).rejects.toMatchObject({ code: 'REPUTATION_INPUT_INVALID' });
  });
});

function contributionInput() {
  return {
    userId: USER_ID,
    system: 'community_reputation' as const,
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
