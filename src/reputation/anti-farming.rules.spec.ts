import { describe, expect, it } from '@jest/globals';
import { AntiFarmingRuleEngine } from './anti-farming.rules';
import type { ContributionRuleInput } from './reputation.rules';

const CONTRIBUTOR_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_CONTRIBUTOR_ID = '00000000-0000-4000-8000-000000000002';
const ACTOR_ID = '00000000-0000-4000-8000-000000000003';
const OTHER_ACTOR_ID = '00000000-0000-4000-8000-000000000004';
const SOURCE_ID = '00000000-0000-4000-8000-000000000005';
const OTHER_SOURCE_ID = '00000000-0000-4000-8000-000000000006';
const OCCURRED_AT = new Date('2026-09-30T10:00:00.000Z');

describe('AntiFarmingRuleEngine', () => {
  const engine = new AntiFarmingRuleEngine();

  it('allows an exact replay as an observable no-op', () => {
    const input = contribution({ sourceId: SOURCE_ID, sourceFingerprint: 'canonical:one' });

    expect(engine.evaluate({
      ...input,
      priorContributionFacts: [{
        contributorUserId: CONTRIBUTOR_ID,
        actorUserId: ACTOR_ID,
        sourceType: 'CORRECTION_ACCEPTED',
        sourceId: SOURCE_ID,
        sourceFingerprint: ' canonical:one ',
        occurredAt: OCCURRED_AT,
      }],
    })).toEqual({
      allowed: true,
      ruleVersion: 'community-antifarming-v1',
      observations: [{ code: 'EXACT_REPLAY', severity: 'OBSERVE' }],
    });
  });

  it('rejects repeated server-derived low-value content for one contributor', () => {
    const result = engine.evaluate({
      ...contribution({ sourceId: OTHER_SOURCE_ID, sourceFingerprint: 'canonical:one' }),
      priorContributionFacts: [{
        contributorUserId: CONTRIBUTOR_ID,
        actorUserId: ACTOR_ID,
        sourceType: 'CORRECTION_ACCEPTED',
        sourceId: SOURCE_ID,
        sourceFingerprint: 'canonical:one',
        occurredAt: OCCURRED_AT,
      }],
    });

    expect(result).toMatchObject({
      allowed: false,
      code: 'REPEATED_LOW_VALUE_SOURCE',
      ruleVersion: 'community-antifarming-v1',
    });
  });

  it('rejects an obvious coordinated reward pair without a client trust flag', () => {
    const result = engine.evaluate({
      ...contribution({
        contributorUserId: OTHER_CONTRIBUTOR_ID,
        sourceId: OTHER_SOURCE_ID,
        sourceFingerprint: 'canonical:one',
      }),
      priorContributionFacts: [{
        contributorUserId: CONTRIBUTOR_ID,
        actorUserId: ACTOR_ID,
        sourceType: 'CORRECTION_ACCEPTED',
        sourceId: SOURCE_ID,
        sourceFingerprint: 'canonical:one',
        occurredAt: OCCURRED_AT,
      }],
    });

    expect(result).toMatchObject({ allowed: false, code: 'COORDINATED_REWARD_PATTERN' });
  });

  it('observes a reused actor/contributor pair without opaque scoring', () => {
    const result = engine.evaluate({
      ...contribution({ sourceId: OTHER_SOURCE_ID, actorUserId: OTHER_ACTOR_ID }),
      priorContributionFacts: [{
        contributorUserId: CONTRIBUTOR_ID,
        actorUserId: OTHER_ACTOR_ID,
        sourceType: 'CORRECTION_ACCEPTED',
        sourceId: SOURCE_ID,
        sourceFingerprint: null,
        occurredAt: OCCURRED_AT,
      }],
    });

    expect(result).toEqual({
      allowed: true,
      ruleVersion: 'community-antifarming-v1',
      observations: [{ code: 'REUSED_ACTOR_CONTRIBUTOR_PAIR', severity: 'OBSERVE' }],
    });
  });

  it('fails closed when prior facts are malformed', () => {
    const result = engine.evaluate({
      ...contribution({ sourceId: OTHER_SOURCE_ID }),
      priorContributionFacts: [{
        contributorUserId: 'not-a-uuid',
        actorUserId: ACTOR_ID,
        sourceType: 'CORRECTION_ACCEPTED',
        sourceId: SOURCE_ID,
        occurredAt: OCCURRED_AT,
      }],
    });

    expect(result).toMatchObject({ allowed: false, code: 'ANTI_FARMING_FACTS_INVALID' });
  });
});

function contribution(overrides: Partial<ContributionRuleInput> = {}): ContributionRuleInput {
  return {
    contributorUserId: CONTRIBUTOR_ID,
    sourceType: 'CORRECTION_ACCEPTED',
    sourceId: SOURCE_ID,
    actorUserId: ACTOR_ID,
    actorRole: 'MEMBER',
    sourceVisibility: 'PUBLIC',
    sourceState: 'ACTIVE',
    occurredAt: OCCURRED_AT,
    ...overrides,
  };
}
