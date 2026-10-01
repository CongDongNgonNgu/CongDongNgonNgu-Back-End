import { describe, expect, it } from '@jest/globals';
import {
  getChallengePublicState,
  toPublicChallengeSummary,
  toPublicParticipation,
  toPublicProgress,
} from './challenge.public';
import type { ChallengeRecord, ChallengeProgressProjection } from './challenge.types';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const CHALLENGE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = '22222222-2222-4222-8222-222222222222';

describe('challenge public projection', () => {
  it('derives safe schedule states without exposing internal rule or reward fields', () => {
    const challenge = createChallenge();
    const summary = toPublicChallengeSummary(challenge, 3, at('2026-10-02T00:00:00.000Z'));

    expect(summary).toMatchObject({
      id: CHALLENGE_ID,
      state: 'ACTIVE',
      participantCount: 3,
      goal: { unit: 'ACTIVITIES', target: 7 },
    });
    expect(summary).not.toHaveProperty('createdByUserId');
    expect(summary).not.toHaveProperty('eligibleActivityTypes');
    expect(summary).not.toHaveProperty('ruleVersion');
    expect(summary).not.toHaveProperty('reward');
    expect(getChallengePublicState({ ...challenge, status: 'CANCELLED' }, at('2026-10-02T00:00:00.000Z')))
      .toBe('CANCELLED');
    expect(getChallengePublicState(challenge, at('2026-09-30T00:00:00.000Z'))).toBe('UPCOMING');
    expect(getChallengePublicState(challenge, at('2026-10-08T00:00:00.000Z'))).toBe('EXPIRED');
  });

  it('projects progress and participation without identity or reward details', () => {
    const projection: ChallengeProgressProjection = {
      challengeId: CHALLENGE_ID,
      userId: USER_ID,
      status: 'COMPLETED',
      progressValue: 7,
      goal: { unit: 'ACTIVITIES', target: 7 },
      completionPercent: 100,
      completedAt: at('2026-10-07T02:00:00.000Z'),
      rewardEvent: {
        eventType: 'challenge.completed',
        challengeId: CHALLENGE_ID,
        userId: USER_ID,
        ruleVersion: 'private-rule-v1',
        occurredAt: at('2026-10-07T02:00:00.000Z'),
      },
    };
    const progress = toPublicProgress(projection);
    const participation = toPublicParticipation({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      challengeId: CHALLENGE_ID,
      userId: USER_ID,
      status: 'COMPLETED',
      joinedAt: at('2026-10-01T00:00:00.000Z'),
      leftAt: null,
      completedAt: projection.completedAt,
      progressValue: 7,
      createdAt: at('2026-10-01T00:00:00.000Z'),
      updatedAt: at('2026-10-07T02:00:00.000Z'),
    });

    expect(progress).toEqual({
      status: 'COMPLETED',
      progressValue: 7,
      goal: { unit: 'ACTIVITIES', target: 7 },
      completionPercent: 100,
      completedAt: projection.completedAt,
    });
    expect(participation).toEqual({
      status: 'COMPLETED',
      joinedAt: at('2026-10-01T00:00:00.000Z'),
      leftAt: null,
      completedAt: projection.completedAt,
      progressValue: 7,
    });
  });
});

function createChallenge(): ChallengeRecord {
  return {
    id: CHALLENGE_ID,
    createdByUserId: OWNER_ID,
    title: 'Bảy ngày nói tiếng Việt',
    description: 'Hoàn thành hoạt động nói có bằng chứng.',
    challengeType: 'SPEAKING',
    languageCode: 'vi',
    level: 'A2',
    topic: 'Daily speaking',
    startAt: at('2026-10-01T00:00:00.000Z'),
    endAt: at('2026-10-08T00:00:00.000Z'),
    timezone: 'Asia/Ho_Chi_Minh',
    goal: { unit: 'ACTIVITIES', target: 7 },
    eligibleActivityTypes: ['SPEAKING_ROOM_ATTENDANCE'],
    ruleVersion: 'challenge-speaking-v1',
    reward: { eventType: 'challenge.completed', ruleVersion: 'community-reputation-v1' },
    status: 'ACTIVE',
    createdAt: at('2026-09-30T00:00:00.000Z'),
    updatedAt: at('2026-09-30T00:00:00.000Z'),
  };
}

function at(value: string): Date {
  return new Date(value);
}
