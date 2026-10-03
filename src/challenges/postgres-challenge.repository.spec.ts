import { describe, expect, it, jest } from '@jest/globals';
import type { Pool } from 'pg';
import { PostgresChallengeRepository } from './postgres-challenge.repository';

describe('PostgresChallengeRepository', () => {
  it('maps PostgreSQL enum-array text into activity values', async () => {
    const row = {
        id: '11111111-1111-4111-8111-111111111111',
        created_by_user_id: '22222222-2222-4222-8222-222222222222',
        title: 'Phase 18 UAT Challenge',
        description: 'Deterministic challenge fixture.',
        challenge_type: 'SENTENCE_PRACTICE',
        language_code: 'vi',
        level: 'A2',
        topic: 'Phase 18',
        starts_at: new Date('2026-10-02T00:00:00.000Z'),
        ends_at: new Date('2026-11-02T00:00:00.000Z'),
        timezone: 'Asia/Ho_Chi_Minh',
        goal_unit: 'ACTIVITIES',
        goal_target: 2,
        eligible_activity_types: '{PRACTICE_COMPLETED}',
        rule_version: 'phase18-uat-challenge-v1',
        reward_event_type: null,
        reward_rule_version: null,
        status: 'ACTIVE',
        created_at: new Date('2026-10-02T00:00:00.000Z'),
        updated_at: new Date('2026-10-02T00:00:00.000Z'),
      };
    const query = jest.fn(async () => ({ rows: [row] }));
    const repository = new PostgresChallengeRepository({ query } as unknown as Pool);

    const challenge = await repository.findChallengeById('11111111-1111-4111-8111-111111111111');

    expect(challenge?.eligibleActivityTypes).toEqual(['PRACTICE_COMPLETED']);
  });
});
