import { describe, expect, it } from '@jest/globals';
import { ContributionRuleEngine } from './reputation.rules';
import { InMemoryReputationLedgerRepository } from './reputation.repository';
import { ReputationService } from './reputation.service';

const ACTOR_ID = '00000000-0000-4000-8000-000000000001';
const CONTRIBUTOR_ID = '00000000-0000-4000-8000-000000000002';
const SOURCE_ID = '00000000-0000-4000-8000-000000000003';
const OCCURRED_AT = new Date('2026-09-30T10:00:00.000Z');

describe('ReputationService', () => {
  it('awards an eligible contribution once even when the source event is replayed', async () => {
    const repository = new InMemoryReputationLedgerRepository();
    const service = new ReputationService(repository, new ContributionRuleEngine());
    const input = {
      contributorUserId: CONTRIBUTOR_ID,
      sourceType: 'CORRECTION_ACCEPTED',
      sourceId: SOURCE_ID,
      actorUserId: ACTOR_ID,
      actorRole: 'MEMBER' as const,
      sourceVisibility: 'PUBLIC' as const,
      sourceState: 'ACTIVE' as const,
      occurredAt: OCCURRED_AT,
    };

    const first = await service.awardContribution(input);
    const retry = await service.awardContribution(input);

    expect(first.decision.eligible).toBe(true);
    expect(first.entry?.delta).toBe(8);
    expect(first.created).toBe(true);
    expect(retry.entry?.id).toBe(first.entry?.id);
    expect(retry.created).toBe(false);
    await expect(service.getBalance(CONTRIBUTOR_ID, 'community_reputation')).resolves.toBe(8);
  });

  it('does not write a ledger entry for an ineligible contribution', async () => {
    const repository = new InMemoryReputationLedgerRepository();
    const service = new ReputationService(repository, new ContributionRuleEngine());

    const result = await service.awardContribution({
      contributorUserId: CONTRIBUTOR_ID,
      sourceType: 'USEFUL_ANSWER_ACCEPTED',
      sourceId: SOURCE_ID,
      actorUserId: CONTRIBUTOR_ID,
      actorRole: 'MEMBER',
      sourceVisibility: 'PUBLIC',
      sourceState: 'ACTIVE',
      occurredAt: OCCURRED_AT,
    });

    expect(result).toMatchObject({
      entry: null,
      created: false,
      decision: { eligible: false, code: 'SELF_REWARD_FORBIDDEN' },
    });
    await expect(service.getBalance(CONTRIBUTOR_ID, 'community_reputation')).resolves.toBe(0);
  });

  it('blocks repeated server-derived contribution content without writing a reward', async () => {
    const repository = new InMemoryReputationLedgerRepository();
    const service = new ReputationService(repository, new ContributionRuleEngine());

    const result = await service.awardContribution({
      contributorUserId: CONTRIBUTOR_ID,
      sourceType: 'CORRECTION_ACCEPTED',
      sourceId: '00000000-0000-4000-8000-000000000004',
      actorUserId: ACTOR_ID,
      actorRole: 'MEMBER',
      sourceVisibility: 'PUBLIC',
      sourceState: 'ACTIVE',
      occurredAt: OCCURRED_AT,
      sourceFingerprint: 'normalized-server-fact',
      priorContributionFacts: [{
        contributorUserId: CONTRIBUTOR_ID,
        actorUserId: ACTOR_ID,
        sourceType: 'CORRECTION_ACCEPTED',
        sourceId: SOURCE_ID,
        sourceFingerprint: 'normalized-server-fact',
        occurredAt: OCCURRED_AT,
      }],
    });

    expect(result).toMatchObject({
      entry: null,
      created: false,
      decision: { eligible: false, code: 'REPEATED_LOW_VALUE_SOURCE' },
      antiFarming: { allowed: false, ruleVersion: 'community-antifarming-v1' },
    });
    await expect(service.getBalance(CONTRIBUTOR_ID, 'community_reputation')).resolves.toBe(0);
  });

  it('reverses an award by appending a compensating entry and preserves history', async () => {
    const repository = new InMemoryReputationLedgerRepository();
    const service = new ReputationService(repository, new ContributionRuleEngine());
    const award = await service.awardContribution({
      contributorUserId: CONTRIBUTOR_ID,
      sourceType: 'RESOURCE_VERIFIED',
      sourceId: SOURCE_ID,
      actorUserId: ACTOR_ID,
      actorRole: 'MODERATOR',
      sourceVisibility: 'PUBLIC',
      sourceState: 'VERIFIED',
      occurredAt: OCCURRED_AT,
    });
    if (!award.entry) throw new Error('Expected an award entry');

    const reversal = await service.reverseEntry({
      entryId: award.entry.id,
      reason: 'Source was later moderated',
      idempotencyKey: `reversal:${award.entry.id}`,
      createdAt: new Date('2026-09-30T11:00:00.000Z'),
    });
    const retry = await service.reverseEntry({
      entryId: award.entry.id,
      reason: 'Source was later moderated',
      idempotencyKey: `reversal:${award.entry.id}`,
      createdAt: new Date('2026-09-30T12:00:00.000Z'),
    });

    expect(reversal.entry.delta).toBe(-12);
    expect(reversal.created).toBe(true);
    expect(retry.entry.id).toBe(reversal.entry.id);
    expect(retry.created).toBe(false);
    await expect(service.getBalance(CONTRIBUTOR_ID, 'community_reputation')).resolves.toBe(0);
    await expect(service.listLedger({ userId: CONTRIBUTOR_ID, limit: 10 })).resolves.toHaveLength(2);
  });

  it('refuses to reverse a missing, reversed, or already compensated entry', async () => {
    const repository = new InMemoryReputationLedgerRepository();
    const service = new ReputationService(repository, new ContributionRuleEngine());

    await expect(service.reverseEntry({
      entryId: SOURCE_ID,
      reason: 'Missing source',
      idempotencyKey: 'reversal:missing',
      createdAt: OCCURRED_AT,
    })).rejects.toMatchObject({ code: 'REPUTATION_ENTRY_NOT_FOUND' });

    const award = await service.awardContribution({
      contributorUserId: CONTRIBUTOR_ID,
      sourceType: 'USEFUL_ANSWER_ACCEPTED',
      sourceId: SOURCE_ID,
      actorUserId: ACTOR_ID,
      actorRole: 'MEMBER',
      sourceVisibility: 'PUBLIC',
      sourceState: 'ACTIVE',
      occurredAt: OCCURRED_AT,
    });
    if (!award.entry) throw new Error('Expected an award entry');
    const reversal = await service.reverseEntry({
      entryId: award.entry.id,
      reason: 'Source was moderated',
      idempotencyKey: `reversal:${award.entry.id}`,
      createdAt: OCCURRED_AT,
    });

    await expect(service.reverseEntry({
      entryId: reversal.entry.id,
      reason: 'Cannot reverse a reversal',
      idempotencyKey: `reversal:${reversal.entry.id}`,
      createdAt: OCCURRED_AT,
    })).rejects.toMatchObject({ code: 'REPUTATION_REVERSAL_TARGET_INVALID' });
    await expect(service.reverseEntry({
      entryId: award.entry.id,
      reason: 'Second compensation',
      idempotencyKey: `reversal:second:${award.entry.id}`,
      createdAt: OCCURRED_AT,
    })).rejects.toMatchObject({ code: 'REPUTATION_REVERSAL_EXISTS' });
  });
});
