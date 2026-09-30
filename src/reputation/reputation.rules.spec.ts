import { describe, expect, it } from '@jest/globals';
import {
  CONTRIBUTION_RULE_VERSION,
  ContributionRuleEngine,
  DEFAULT_CONTRIBUTION_RULES,
} from './reputation.rules';

const ACTOR_ID = '00000000-0000-4000-8000-000000000001';
const CONTRIBUTOR_ID = '00000000-0000-4000-8000-000000000002';
const SOURCE_ID = '00000000-0000-4000-8000-000000000003';
const OCCURRED_AT = new Date('2026-09-30T10:00:00.000Z');

describe('ContributionRuleEngine', () => {
  it('awards only approved source events with a stable versioned identity', () => {
    const engine = new ContributionRuleEngine();

    const decision = engine.evaluate({
      contributorUserId: CONTRIBUTOR_ID,
      sourceType: 'USEFUL_ANSWER_ACCEPTED',
      sourceId: SOURCE_ID,
      actorUserId: ACTOR_ID,
      actorRole: 'MEMBER',
      sourceVisibility: 'PUBLIC',
      sourceState: 'ACTIVE',
      occurredAt: OCCURRED_AT,
    });

    expect(decision).toEqual({
      eligible: true,
      system: 'community_reputation',
      sourceType: 'USEFUL_ANSWER_ACCEPTED',
      sourceId: SOURCE_ID,
      delta: 5,
      reason: 'Accepted useful answer',
      ruleVersion: CONTRIBUTION_RULE_VERSION,
      idempotencyKey: `reputation:USEFUL_ANSWER_ACCEPTED:${SOURCE_ID}`,
    });
  });

  it('contains bounded rules for accepted corrections, verified resources and reviewer verification', () => {
    expect(DEFAULT_CONTRIBUTION_RULES.map((rule) => [rule.sourceType, rule.delta])).toEqual([
      ['USEFUL_ANSWER_ACCEPTED', 5],
      ['CORRECTION_ACCEPTED', 8],
      ['TRANSLATION_VERIFIED', 10],
      ['RESOURCE_VERIFIED', 12],
      ['REVIEW_VERIFICATION', 3],
    ]);
    expect(DEFAULT_CONTRIBUTION_RULES.every((rule) => rule.system === 'community_reputation')).toBe(true);
  });

  it.each([
    ['self-accept', { actorUserId: CONTRIBUTOR_ID, actorRole: 'MEMBER' as const }, 'SELF_REWARD_FORBIDDEN'],
    ['private answer', { actorUserId: ACTOR_ID, actorRole: 'MEMBER' as const, sourceVisibility: 'PRIVATE' as const }, 'SOURCE_NOT_ELIGIBLE'],
    ['unverified resource', { actorUserId: ACTOR_ID, actorRole: 'MEMBER' as const, sourceType: 'RESOURCE_VERIFIED' as const, sourceState: 'ACTIVE' as const }, 'SOURCE_NOT_ELIGIBLE'],
    ['member verification', { actorUserId: ACTOR_ID, actorRole: 'MEMBER' as const, sourceType: 'RESOURCE_VERIFIED' as const, sourceState: 'VERIFIED' as const }, 'REVIEWER_REQUIRED'],
    ['member review', { actorUserId: ACTOR_ID, actorRole: 'MEMBER' as const, sourceType: 'REVIEW_VERIFICATION' as const, sourceState: 'VERIFIED' as const }, 'REVIEWER_REQUIRED'],
  ] as const)('fails closed for %s', (_name, overrides, code) => {
    const engine = new ContributionRuleEngine();
    const baseInput = {
      contributorUserId: CONTRIBUTOR_ID,
      sourceType: 'USEFUL_ANSWER_ACCEPTED',
      sourceId: SOURCE_ID,
      actorUserId: ACTOR_ID,
      actorRole: 'MEMBER',
      sourceVisibility: 'PUBLIC',
      sourceState: 'ACTIVE',
      occurredAt: OCCURRED_AT,
    };
    const decision = engine.evaluate({ ...baseInput, ...overrides } as never);

    expect(decision).toMatchObject({ eligible: false, code });
  });

  it('does not create a raw-volume rule for created responses or reactions', () => {
    const engine = new ContributionRuleEngine();

    const decision = engine.evaluate({
      contributorUserId: CONTRIBUTOR_ID,
      sourceType: 'STRUCTURED_RESPONSE_CREATED' as never,
      sourceId: SOURCE_ID,
      actorUserId: ACTOR_ID,
      actorRole: 'MEMBER',
      sourceVisibility: 'PUBLIC',
      sourceState: 'ACTIVE',
      occurredAt: OCCURRED_AT,
    });

    expect(decision).toMatchObject({ eligible: false, code: 'RULE_NOT_FOUND' });
  });

  it('fails closed when an internal event carries an invalid timestamp', () => {
    const engine = new ContributionRuleEngine();

    const decision = engine.evaluate({
      contributorUserId: CONTRIBUTOR_ID,
      sourceType: 'USEFUL_ANSWER_ACCEPTED',
      sourceId: SOURCE_ID,
      actorUserId: ACTOR_ID,
      actorRole: 'MEMBER',
      sourceVisibility: 'PUBLIC',
      sourceState: 'ACTIVE',
      occurredAt: null as never,
    });

    expect(decision).toMatchObject({ eligible: false, code: 'INVALID_SOURCE' });
  });
});
