import { describe, expect, it } from '@jest/globals';
import { AntiFarmingRuleEngine } from '../reputation/anti-farming.rules';
import { ContributionRuleEngine } from '../reputation/reputation.rules';
import {
  InMemoryReputationLedgerRepository,
} from '../reputation/reputation.repository';
import { ReputationService } from '../reputation/reputation.service';
import { MembershipContributionCreditService } from './membership.contribution-credit';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const SOURCE_ONE = '44444444-4444-4444-8444-444444444444';
const SOURCE_TWO = '55555555-5555-4555-8555-555555555555';
const SOURCE_THREE = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-09-30T12:00:00.000Z');

function build() {
  const repository = new InMemoryReputationLedgerRepository();
  const reputation = new ReputationService(
    repository,
    new ContributionRuleEngine(),
    new AntiFarmingRuleEngine(),
  );
  return {
    repository,
    reputation,
    credits: new MembershipContributionCreditService(reputation),
  };
}

async function award(
  reputation: ReputationService,
  input: Partial<Parameters<ReputationService['awardContribution']>[0]> = {},
) {
  return reputation.awardContribution({
    contributorUserId: USER_ID,
    sourceType: 'TRANSLATION_VERIFIED',
    sourceId: SOURCE_ONE,
    actorUserId: ACTOR_ID,
    actorRole: 'MODERATOR',
    sourceVisibility: 'PUBLIC',
    sourceState: 'VERIFIED',
    occurredAt: NOW,
    ...input,
  });
}

describe('MembershipContributionCreditService', () => {
  it('derives non-monetary eligibility credit from the current net Community Reputation balance', async () => {
    const { reputation, credits } = build();
    await award(reputation);
    await award(reputation, { sourceType: 'RESOURCE_VERIFIED', sourceId: SOURCE_TWO });

    await expect(credits.getProjection(USER_ID, NOW)).resolves.toMatchObject({
      contractVersion: 'membership-contribution-credit-v1',
      type: 'MEMBERSHIP_ELIGIBILITY_CREDIT',
      ruleVersion: 'membership-credit-v1',
      conversion: { reputationPointsPerCredit: 10 },
      eligibleReputationPoints: 22,
      availableCreditUnits: 2,
      remainderReputationPoints: 2,
      expirationPolicy: 'NONE_DERIVED_FROM_CURRENT_LEDGER',
      redemption: {
        mode: 'PROJECTION_ONLY',
        grantsMembership: false,
        actsAsPaymentTender: false,
      },
      evaluatedAt: NOW.toISOString(),
    });
  });

  it('inherits Phase 10 idempotency and anti-farming eligibility instead of trusting a client credit claim', async () => {
    const { reputation, credits } = build();
    const first = await award(reputation);
    const replay = await award(reputation);
    const rejected = await award(reputation, {
      sourceId: SOURCE_THREE,
      actorUserId: USER_ID,
    });

    expect(first).toMatchObject({ created: true, entry: { delta: 10 } });
    expect(replay).toMatchObject({ created: false });
    expect(rejected).toMatchObject({ entry: null, created: false });
    await expect(credits.getProjection(OTHER_USER_ID, NOW)).resolves.toMatchObject({
      eligibleReputationPoints: 0,
      availableCreditUnits: 0,
    });
    await expect(credits.getProjection(USER_ID, NOW)).resolves.toMatchObject({
      eligibleReputationPoints: 10,
      availableCreditUnits: 1,
    });
  });

  it('recomputes after an append-only reputation reversal without deleting the original history', async () => {
    const { repository, reputation, credits } = build();
    const awardResult = await award(reputation);
    const originalId = awardResult.entry!.id;

    await reputation.reverseEntry({
      entryId: originalId,
      reason: 'Verified contribution was reversed',
      idempotencyKey: `reversal:${originalId}`,
      createdAt: new Date(NOW.getTime() + 1_000),
    });

    await expect(credits.getProjection(USER_ID, NOW)).resolves.toMatchObject({
      eligibleReputationPoints: 0,
      availableCreditUnits: 0,
    });
    await expect(repository.findById(originalId)).resolves.toMatchObject({
      id: originalId,
      delta: 10,
      reversalOfEntryId: null,
    });
    await expect(repository.findByReversalOfEntryId(originalId)).resolves.toMatchObject({
      delta: -10,
      reversalOfEntryId: originalId,
    });
  });

  it('returns the same projection for concurrent/replayed reads', async () => {
    const { reputation, credits } = build();
    await award(reputation);
    await award(reputation, { sourceType: 'RESOURCE_VERIFIED', sourceId: SOURCE_TWO });

    const projections = await Promise.all(
      Array.from({ length: 32 }, () => credits.getProjection(USER_ID, NOW)),
    );

    expect(new Set(projections.map((projection) => JSON.stringify(projection))).size).toBe(1);
  });

  it('fails closed for invalid identities and never accepts a user-supplied balance', async () => {
    const { credits } = build();

    await expect(credits.getProjection('not-a-uuid', NOW)).rejects.toMatchObject({
      code: 'MEMBERSHIP_CREDIT_USER_INVALID',
    });
    expect(Object.keys(credits)).not.toContain('setBalance');
  });
});
