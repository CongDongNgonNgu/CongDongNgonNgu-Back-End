import { describe, expect, it } from '@jest/globals';
import {
  ChallengeRuleEngine,
  normalizeChallengeDefinition,
} from './challenge.rules';

const CHALLENGE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SOURCE_ID = '33333333-3333-4333-8333-333333333333';

const baseInput = {
  title: 'Bảy ngày nói tiếng Việt',
  description: 'Hoàn thành một hoạt động nói có bằng chứng mỗi ngày.',
  challengeType: 'SPEAKING' as const,
  languageCode: 'vi',
  level: 'A2' as const,
  topic: 'Daily speaking',
  startAt: new Date('2026-10-01T00:00:00.000Z'),
  endAt: new Date('2026-10-08T00:00:00.000Z'),
  timezone: 'Asia/Ho_Chi_Minh',
  goalUnit: 'ACTIVITIES' as const,
  goalTarget: 7,
  eligibleActivityTypes: ['SPEAKING_ROOM_ATTENDANCE'] as const,
  ruleVersion: 'challenge-speaking-v1',
  reward: { eventType: 'challenge.completed', ruleVersion: 'community-reputation-v1' },
  createdByUserId: USER_ID,
  status: 'ACTIVE' as const,
  createdAt: new Date('2026-09-30T00:00:00.000Z'),
};

describe('ChallengeRuleEngine', () => {
  it('normalizes a versioned finite challenge definition and keeps the timezone policy', () => {
    const challenge = normalizeChallengeDefinition(baseInput);

    expect(challenge).toMatchObject({
      title: 'Bảy ngày nói tiếng Việt',
      languageCode: 'vi',
      timezone: 'Asia/Ho_Chi_Minh',
      goal: { unit: 'ACTIVITIES', target: 7 },
      eligibleActivityTypes: ['SPEAKING_ROOM_ATTENDANCE'],
      ruleVersion: 'challenge-speaking-v1',
    });
    expect(challenge.startAt).toEqual(baseInput.startAt);
    expect(challenge.endAt).toEqual(baseInput.endAt);
  });

  it('rejects an invalid timezone and non-finite goal', () => {
    expect(() => normalizeChallengeDefinition({ ...baseInput, timezone: 'UTC+7' }))
      .toThrow('Challenge timezone is invalid');
    expect(() => normalizeChallengeDefinition({ ...baseInput, goalTarget: 0 }))
      .toThrow('Challenge goal is invalid');
  });

  it('accepts trusted activity only when the rule, window and evidence are valid', () => {
    const challenge = {
      ...normalizeChallengeDefinition(baseInput),
      id: CHALLENGE_ID,
    };
    const engine = new ChallengeRuleEngine();

    expect(engine.evaluateProgress({
      challenge,
      userId: USER_ID,
      activityType: 'SPEAKING_ROOM_ATTENDANCE',
      sourceId: SOURCE_ID,
      units: 1,
      occurredAt: new Date('2026-10-02T03:00:00.000Z'),
    }, new Date('2026-10-02T04:00:00.000Z'))).toMatchObject({
      eligible: true,
      idempotencyKey: `challenge:${CHALLENGE_ID}:SPEAKING_ROOM_ATTENDANCE:${SOURCE_ID}`,
      ruleVersion: 'challenge-speaking-v1',
    });
  });

  it('rejects client-shaped activity outside the eligible rule or challenge window', () => {
    const challenge = {
      ...normalizeChallengeDefinition(baseInput),
      id: CHALLENGE_ID,
    };
    const engine = new ChallengeRuleEngine();

    expect(engine.evaluateProgress({
      challenge,
      userId: USER_ID,
      activityType: 'PRACTICE_COMPLETED',
      sourceId: SOURCE_ID,
      units: 999,
      occurredAt: new Date('2026-10-02T03:00:00.000Z'),
    }, new Date('2026-10-02T04:00:00.000Z'))).toMatchObject({
      eligible: false,
      code: 'CHALLENGE_ACTIVITY_NOT_ELIGIBLE',
    });

    expect(engine.evaluateProgress({
      challenge,
      userId: USER_ID,
      activityType: 'SPEAKING_ROOM_ATTENDANCE',
      sourceId: SOURCE_ID,
      units: 1,
      occurredAt: new Date('2026-10-08T00:00:00.000Z'),
    }, new Date('2026-10-08T00:01:00.000Z'))).toMatchObject({
      eligible: false,
      code: 'CHALLENGE_EXPIRED',
    });
  });
});
