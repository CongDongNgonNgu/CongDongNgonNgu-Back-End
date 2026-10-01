import { describe, expect, it } from '@jest/globals';
import type { IdentityRepository } from '../identity/identity.repository';
import { InMemoryProfileRepository } from '../profile/profile.repository';
import { ChallengeRuleEngine } from './challenge.rules';
import { ChallengeService } from './challenge.service';
import { InMemoryChallengeRepository } from './challenge.repository';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const LEARNER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const SOURCE_ONE = '44444444-4444-4444-8444-444444444444';
const SOURCE_TWO = '55555555-5555-4555-8555-555555555555';

describe('ChallengeService', () => {
  it('keeps progress server-derived and exact retries idempotent', async () => {
    const { service } = await createService();
    const challenge = await service.createChallenge(baseDefinition());
    await service.joinChallenge(challenge.id, LEARNER_ID, at('2026-10-01T01:00:00.000Z'));

    const first = await service.recordTrustedActivity(LEARNER_ID, challenge.id, {
      activityType: 'SPEAKING_ROOM_ATTENDANCE',
      sourceId: SOURCE_ONE,
      units: 1,
      occurredAt: at('2026-10-02T03:00:00.000Z'),
    }, at('2026-10-02T04:00:00.000Z'));
    const replay = await service.recordTrustedActivity(LEARNER_ID, challenge.id, {
      activityType: 'SPEAKING_ROOM_ATTENDANCE',
      sourceId: SOURCE_ONE,
      units: 1,
      occurredAt: at('2026-10-02T03:00:00.000Z'),
    }, at('2026-10-02T04:01:00.000Z'));

    expect(first).toMatchObject({ outcome: 'CREATED', projection: { progressValue: 1, status: 'JOINED' } });
    expect(replay).toMatchObject({ outcome: 'REPLAYED', projection: { progressValue: 1, status: 'JOINED' } });
  });

  it('rejects altered replay and an unjoined cross-user progress claim', async () => {
    const { service } = await createService();
    const challenge = await service.createChallenge(baseDefinition());
    await service.joinChallenge(challenge.id, LEARNER_ID, at('2026-10-01T01:00:00.000Z'));

    await service.recordTrustedActivity(LEARNER_ID, challenge.id, {
      activityType: 'SPEAKING_ROOM_ATTENDANCE',
      sourceId: SOURCE_ONE,
      units: 1,
      occurredAt: at('2026-10-02T03:00:00.000Z'),
    }, at('2026-10-02T04:00:00.000Z'));

    await expect(service.recordTrustedActivity(LEARNER_ID, challenge.id, {
      activityType: 'SPEAKING_ROOM_ATTENDANCE',
      sourceId: SOURCE_ONE,
      units: 2,
      occurredAt: at('2026-10-02T03:00:00.000Z'),
    }, at('2026-10-02T04:00:00.000Z'))).rejects.toMatchObject({
      code: 'CHALLENGE_ACTIVITY_REPLAY_CONFLICT',
    });

    await expect(service.recordTrustedActivity(OTHER_ID, challenge.id, {
      activityType: 'SPEAKING_ROOM_ATTENDANCE',
      sourceId: SOURCE_TWO,
      units: 1,
      occurredAt: at('2026-10-02T03:00:00.000Z'),
    }, at('2026-10-02T04:00:00.000Z'))).rejects.toMatchObject({
      code: 'CHALLENGE_NOT_JOINED',
    });
  });

  it('marks completion once and emits an optional bounded reward hook', async () => {
    const { service } = await createService();
    const challenge = await service.createChallenge(baseDefinition({ goalTarget: 2 }));
    await service.joinChallenge(challenge.id, LEARNER_ID, at('2026-10-01T01:00:00.000Z'));

    await service.recordTrustedActivity(LEARNER_ID, challenge.id, {
      activityType: 'SPEAKING_ROOM_ATTENDANCE',
      sourceId: SOURCE_ONE,
      units: 1,
      occurredAt: at('2026-10-02T03:00:00.000Z'),
    }, at('2026-10-02T04:00:00.000Z'));
    const completed = await service.recordTrustedActivity(LEARNER_ID, challenge.id, {
      activityType: 'SPEAKING_ROOM_ATTENDANCE',
      sourceId: SOURCE_TWO,
      units: 1,
      occurredAt: at('2026-10-03T03:00:00.000Z'),
    }, at('2026-10-03T04:00:00.000Z'));

    expect(completed.projection).toMatchObject({
      progressValue: 2,
      status: 'COMPLETED',
      completionPercent: 100,
      rewardEvent: {
        eventType: 'challenge.completed',
        challengeId: challenge.id,
        userId: LEARNER_ID,
      },
    });
  });
});

async function createService() {
  const identities = {
    findUserById: async (id: string) => [OWNER_ID, LEARNER_ID, OTHER_ID].includes(id)
      ? {
          id,
          email: `${id}@example.test`,
          displayName: 'Challenge User',
          passwordHash: null,
          status: 'ACTIVE' as const,
          emailVerifiedAt: new Date('2026-09-30T00:00:00.000Z'),
          createdAt: new Date('2026-09-30T00:00:00.000Z'),
          updatedAt: new Date('2026-09-30T00:00:00.000Z'),
          roles: ['MEMBER' as const],
        }
      : null,
  } as IdentityRepository;
  return {
    service: new ChallengeService(
      new InMemoryChallengeRepository(),
      new InMemoryProfileRepository(),
      identities,
      new ChallengeRuleEngine(),
    ),
  };
}

function baseDefinition(overrides: { goalTarget?: number } = {}) {
  return {
    title: 'Bảy ngày nói tiếng Việt',
    description: 'Hoàn thành hoạt động nói có bằng chứng.',
    challengeType: 'SPEAKING' as const,
    languageCode: 'vi',
    level: 'A2' as const,
    topic: 'Daily speaking',
    startAt: at('2026-10-01T00:00:00.000Z'),
    endAt: at('2026-10-08T00:00:00.000Z'),
    timezone: 'Asia/Ho_Chi_Minh',
    goalUnit: 'ACTIVITIES' as const,
    goalTarget: 7,
    eligibleActivityTypes: ['SPEAKING_ROOM_ATTENDANCE'] as const,
    ruleVersion: 'challenge-speaking-v1',
    reward: { eventType: 'challenge.completed', ruleVersion: 'community-reputation-v1' },
    createdByUserId: OWNER_ID,
    status: 'ACTIVE' as const,
    createdAt: at('2026-09-30T00:00:00.000Z'),
    ...overrides,
  };
}

function at(value: string): Date {
  return new Date(value);
}
