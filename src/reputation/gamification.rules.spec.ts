import { describe, expect, it } from '@jest/globals';
import {
  CONTRIBUTOR_BADGES,
  deriveCommunityReputation,
  deriveContributorBadges,
  deriveContributorLevel,
} from './gamification.rules';
import type { ReputationLedgerEntry, ReputationSourceType } from './reputation.types';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const CORRECTION_SOURCE_ID = '00000000-0000-4000-8000-000000000002';
const RESOURCE_SOURCE_ID = '00000000-0000-4000-8000-000000000003';
const CORRECTION_ENTRY_ID = '00000000-0000-4000-8000-000000000004';
const RESOURCE_ENTRY_ID = '00000000-0000-4000-8000-000000000005';
const REVERSAL_ENTRY_ID = '00000000-0000-4000-8000-000000000006';

describe('community gamification projections', () => {
  it('derives transparent levels at boundaries and downgrades after reversal', () => {
    expect(deriveContributorLevel(-8)).toMatchObject({ id: 'NEWCOMER', nextLevel: { id: 'HELPER' } });
    expect(deriveContributorLevel(5)).toMatchObject({ id: 'HELPER', nextLevel: { id: 'CONTRIBUTOR' } });
    expect(deriveContributorLevel(25)).toMatchObject({ id: 'CONTRIBUTOR' });
    expect(deriveContributorLevel(100)).toMatchObject({ id: 'COMMUNITY_STEWARD', nextLevel: null });
    expect(deriveContributorLevel(24 - 8)).toMatchObject({ id: 'HELPER' });
  });

  it('returns one stable badge projection and exposes a reversed source as revoked', () => {
    const entries = [
      entry({
        id: CORRECTION_ENTRY_ID,
        sourceType: 'CORRECTION_ACCEPTED',
        sourceId: CORRECTION_SOURCE_ID,
        delta: 8,
        createdAt: '2026-09-30T10:00:00.000Z',
      }),
      entry({
        id: RESOURCE_ENTRY_ID,
        sourceType: 'RESOURCE_VERIFIED',
        sourceId: RESOURCE_SOURCE_ID,
        delta: 12,
        createdAt: '2026-09-30T11:00:00.000Z',
      }),
      entry({
        id: REVERSAL_ENTRY_ID,
        sourceType: 'CORRECTION_ACCEPTED',
        sourceId: CORRECTION_SOURCE_ID,
        delta: -8,
        reversalOfEntryId: CORRECTION_ENTRY_ID,
        createdAt: '2026-09-30T12:00:00.000Z',
      }),
    ];

    const badges = deriveContributorBadges(entries);
    expect(badges).toHaveLength(CONTRIBUTOR_BADGES.length);
    expect(new Set(badges.map((badge) => badge.id)).size).toBe(CONTRIBUTOR_BADGES.length);
    expect(badges.find((badge) => badge.id === 'CORRECTION_HELPER')).toMatchObject({
      status: 'REVOKED',
      evidenceSourceIds: [CORRECTION_SOURCE_ID],
      ruleVersion: 'community-gamification-v1',
      revokedAt: '2026-09-30T12:00:00.000Z',
    });
    expect(badges.find((badge) => badge.id === 'RESOURCE_STEWARD')).toMatchObject({
      status: 'EARNED',
      evidenceSourceIds: [RESOURCE_SOURCE_ID],
    });
    expect(badges.find((badge) => badge.id === 'FIRST_TRUSTED_CONTRIBUTION')).toMatchObject({
      status: 'EARNED',
      evidenceSourceIds: [RESOURCE_SOURCE_ID],
    });
  });

  it('is order-independent and does not count duplicate source rows twice', () => {
    const first = entry({
      id: CORRECTION_ENTRY_ID,
      sourceType: 'CORRECTION_ACCEPTED',
      sourceId: CORRECTION_SOURCE_ID,
      delta: 8,
      createdAt: '2026-09-30T10:00:00.000Z',
    });
    const duplicate = entry({
      id: RESOURCE_ENTRY_ID,
      sourceType: 'CORRECTION_ACCEPTED',
      sourceId: CORRECTION_SOURCE_ID,
      delta: 8,
      createdAt: '2026-09-30T11:00:00.000Z',
    });
    const reversed = [...deriveContributorBadges([first, duplicate])];
    const ordered = [...deriveContributorBadges([duplicate, first])];

    expect(ordered).toEqual(reversed);
    expect(deriveCommunityReputation([first, duplicate])).toBe(16);
    expect(reversed.find((badge) => badge.id === 'CORRECTION_HELPER')?.evidenceSourceIds).toEqual([
      CORRECTION_SOURCE_ID,
    ]);
  });
});

function entry(input: {
  id: string;
  sourceType: ReputationSourceType;
  sourceId: string;
  delta: number;
  createdAt: string;
  reversalOfEntryId?: string | null;
}): ReputationLedgerEntry {
  return {
    id: input.id,
    userId: USER_ID,
    system: 'community_reputation',
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    delta: input.delta,
    reason: input.delta > 0 ? 'Verified contribution' : 'Moderation reversal',
    ruleVersion: 'community-reputation-v1',
    idempotencyKey: `entry:${input.id}`,
    reversalOfEntryId: input.reversalOfEntryId ?? null,
    createdAt: new Date(input.createdAt),
  };
}
