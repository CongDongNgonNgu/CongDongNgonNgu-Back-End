import { describe, expect, it } from '@jest/globals';
import type { IdentityRepository } from '../identity/identity.repository';
import { InMemoryProfileRepository } from '../profile/profile.repository';
import { ChallengeRuleEngine } from './challenge.rules';
import { ChallengeService } from './challenge.service';
import { InMemoryChallengeRepository } from './challenge.repository';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const LEARNER_ID = '22222222-2222-4222-8222-222222222222';

describe('ChallengeService discovery and participation projection', () => {
  it('lists only public active/upcoming challenges by default and reports participant counts', async () => {
    const { service } = createService();
    const active = await service.createChallenge(baseDefinition({ title: 'Đang diễn ra' }));
    await service.createChallenge(baseDefinition({
      title: 'Đã hết hạn',
      startAt: at('2026-09-01T00:00:00.000Z'),
      endAt: at('2026-09-10T00:00:00.000Z'),
    }));
    await service.createChallenge(baseDefinition({
      title: 'Sắp bắt đầu',
      startAt: at('2026-10-05T00:00:00.000Z'),
      endAt: at('2026-10-12T00:00:00.000Z'),
    }));
    const cancelled = await service.createChallenge(baseDefinition({
      title: 'Đã hủy',
      status: 'CANCELLED',
    }));
    await service.joinChallenge(active.id, LEARNER_ID, at('2026-10-02T01:00:00.000Z'));

    const result = await service.listPublicChallenges({}, at('2026-10-02T00:00:00.000Z'));

    expect(result.map((item) => item.title)).toEqual(['Đang diễn ra', 'Sắp bắt đầu']);
    expect(result[0]).toMatchObject({ state: 'ACTIVE', participantCount: 1 });
    expect(result.find((item) => item.id === cancelled.id)).toBeUndefined();
  });

  it('supports explicit public state filters and keeps expired detail understandable', async () => {
    const { service } = createService();
    const expired = await service.createChallenge(baseDefinition({
      title: 'Đã kết thúc',
      startAt: at('2026-09-01T00:00:00.000Z'),
      endAt: at('2026-09-10T00:00:00.000Z'),
    }));
    await service.createChallenge(baseDefinition({
      title: 'Bản nháp',
      status: 'DRAFT',
    }));
    const now = at('2026-10-02T00:00:00.000Z');

    const expiredList = await service.listPublicChallenges({ state: 'EXPIRED' }, now);
    const detail = await service.getPublicChallenge(expired.id, now);

    expect(expiredList).toHaveLength(1);
    expect(expiredList[0]).toMatchObject({ id: expired.id, state: 'EXPIRED' });
    expect(detail).toMatchObject({ id: expired.id, state: 'EXPIRED', participantCount: 0 });
    await expect(service.listPublicChallenges({ state: 'CANCELLED' }, now)).resolves.toEqual([]);
  });

  it('returns null before joining and a safe server projection after joining', async () => {
    const { service } = createService();
    const challenge = await service.createChallenge(baseDefinition());

    await expect(service.getViewerProgress(challenge.id, LEARNER_ID)).resolves.toBeNull();
    await service.joinChallenge(challenge.id, LEARNER_ID, at('2026-10-02T01:00:00.000Z'));

    const progress = await service.getViewerProgress(challenge.id, LEARNER_ID);

    expect(progress).toMatchObject({
      status: 'JOINED',
      progressValue: 0,
      goal: { unit: 'ACTIVITIES', target: 7 },
      completionPercent: 0,
    });
    expect(progress).not.toHaveProperty('userId');
    expect(progress).not.toHaveProperty('rewardEvent');
  });
});

function createService() {
  const identities = {
    findUserById: async (id: string) => [OWNER_ID, LEARNER_ID].includes(id)
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

function baseDefinition(overrides: Record<string, unknown> = {}) {
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
