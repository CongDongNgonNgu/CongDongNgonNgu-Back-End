import { describe, expect, it } from '@jest/globals';
import { GamificationService } from './gamification.service';
import { InMemoryReputationLedgerRepository } from './reputation.repository';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const CORRECTION_SOURCE_ID = '00000000-0000-4000-8000-000000000002';
const RESOURCE_SOURCE_ID = '00000000-0000-4000-8000-000000000003';

describe('GamificationService', () => {
  it('derives contributor level, finite badges and reversal summary from the ledger', async () => {
    const repository = new InMemoryReputationLedgerRepository();
    const service = new GamificationService(repository);
    const correction = await repository.append({
      userId: USER_ID,
      system: 'community_reputation',
      sourceType: 'CORRECTION_ACCEPTED',
      sourceId: CORRECTION_SOURCE_ID,
      delta: 8,
      reason: 'Accepted language correction',
      ruleVersion: 'community-reputation-v1',
      idempotencyKey: 'reputation:CORRECTION_ACCEPTED:source-1',
      reversalOfEntryId: null,
      createdAt: new Date('2026-09-30T10:00:00.000Z'),
    });
    await repository.append({
      userId: USER_ID,
      system: 'community_reputation',
      sourceType: 'RESOURCE_VERIFIED',
      sourceId: RESOURCE_SOURCE_ID,
      delta: 12,
      reason: 'Verified language resource contribution',
      ruleVersion: 'community-reputation-v1',
      idempotencyKey: 'reputation:RESOURCE_VERIFIED:source-2',
      reversalOfEntryId: null,
      createdAt: new Date('2026-09-30T11:00:00.000Z'),
    });
    await repository.append({
      userId: USER_ID,
      system: 'community_reputation',
      sourceType: 'CORRECTION_ACCEPTED',
      sourceId: CORRECTION_SOURCE_ID,
      delta: -8,
      reason: 'Source was later moderated',
      ruleVersion: 'community-reputation-v1',
      idempotencyKey: `reversal:${correction.entry.id}`,
      reversalOfEntryId: correction.entry.id,
      createdAt: new Date('2026-09-30T12:00:00.000Z'),
    });

    const progress = await service.getContributorProgress(USER_ID);

    expect(progress).toMatchObject({
      communityReputation: 12,
      contributorLevel: { id: 'HELPER', ruleVersion: 'community-gamification-v1' },
      activeContributionCount: 1,
      ledgerSummary: { totalEntries: 3, reversedEntries: 1 },
    });
    expect(progress.badges.find((badge) => badge.id === 'CORRECTION_HELPER')).toMatchObject({
      status: 'REVOKED',
    });
    expect(progress.badges.find((badge) => badge.id === 'RESOURCE_STEWARD')).toMatchObject({
      status: 'EARNED',
    });
  });

  it('keeps projection deterministic under concurrent reads and clamps negative reputation to newcomer', async () => {
    const repository = new InMemoryReputationLedgerRepository();
    const service = new GamificationService(repository);
    const award = await repository.append({
      userId: USER_ID,
      system: 'community_reputation',
      sourceType: 'CORRECTION_ACCEPTED',
      sourceId: CORRECTION_SOURCE_ID,
      delta: 8,
      reason: 'Accepted language correction',
      ruleVersion: 'community-reputation-v1',
      idempotencyKey: 'reputation:CORRECTION_ACCEPTED:negative-test',
      reversalOfEntryId: null,
      createdAt: new Date('2026-09-30T10:00:00.000Z'),
    });
    await repository.append({
      userId: USER_ID,
      system: 'community_reputation',
      sourceType: 'CORRECTION_ACCEPTED',
      sourceId: CORRECTION_SOURCE_ID,
      delta: -20,
      reason: 'Correction reversal',
      ruleVersion: 'community-reputation-v1',
      idempotencyKey: `reversal:negative:${award.entry.id}`,
      reversalOfEntryId: award.entry.id,
      createdAt: new Date('2026-09-30T11:00:00.000Z'),
    });

    const [first, second] = await Promise.all([
      service.getContributorProgress(USER_ID),
      service.getContributorProgress(USER_ID),
    ]);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      communityReputation: -12,
      contributorLevel: { id: 'NEWCOMER' },
      activeContributionCount: 0,
    });
  });
});
