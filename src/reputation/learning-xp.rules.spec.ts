import { LearningXpRuleEngine } from './learning-xp.rules';

const userId = '11111111-1111-4111-8111-111111111111';
const now = new Date('2026-09-30T10:00:00.000Z');

describe('LearningXpRuleEngine', () => {
  const engine = new LearningXpRuleEngine();

  it.each([
    ['PRACTICE_COMPLETED', { completedUnits: 1 }, 20],
    ['LEARNING_SESSION_COMPLETED', { durationSeconds: 60 }, 10],
    ['VOCABULARY_MILESTONE', { milestoneNumber: 1 }, 10],
    ['QUIZ_MILESTONE', { scorePercent: 60 }, 15],
  ] as const)('awards bounded XP for %s', (sourceType, evidence, delta) => {
    const result = engine.evaluate(
      {
        userId,
        sourceType,
        sourceId: '22222222-2222-4222-8222-222222222222',
        completedAt: new Date('2026-09-30T09:00:00.000Z'),
        status: 'COMPLETED',
        ...evidence,
      },
      now,
    );

    expect(result).toMatchObject({
      eligible: true,
      delta,
      ruleVersion: 'learning-xp-v1',
      idempotencyKey: `learning:${sourceType}:22222222-2222-4222-8222-222222222222`,
    });
  });

  it.each([
    ['FAILED', { completedUnits: 1 }, 'LEARNING_COMPLETION_REQUIRED'],
    ['ABANDONED', { durationSeconds: 120 }, 'LEARNING_COMPLETION_REQUIRED'],
  ] as const)('does not award XP for %s activities', (status, evidence, code) => {
    const result = engine.evaluate(
      {
        userId,
        sourceType: 'PRACTICE_COMPLETED',
        sourceId: '33333333-3333-4333-8333-333333333333',
        completedAt: new Date('2026-09-30T09:00:00.000Z'),
        status,
        ...evidence,
      },
      now,
    );

    expect(result).toEqual({
      eligible: false,
      code,
      reason: 'Only completed learning activities earn XP',
    });
  });

  it.each([
    ['PRACTICE_COMPLETED', { completedUnits: 0 }],
    ['LEARNING_SESSION_COMPLETED', { durationSeconds: 59 }],
    ['VOCABULARY_MILESTONE', { milestoneNumber: 0 }],
    ['QUIZ_MILESTONE', { scorePercent: 59 }],
  ] as const)('fails closed when %s evidence is insufficient', (sourceType, evidence) => {
    const result = engine.evaluate(
      {
        userId,
        sourceType,
        sourceId: '44444444-4444-4444-8444-444444444444',
        completedAt: new Date('2026-09-30T09:00:00.000Z'),
        status: 'COMPLETED',
        ...evidence,
      },
      now,
    );

    expect(result).toMatchObject({ eligible: false, code: 'LEARNING_EVIDENCE_INSUFFICIENT' });
  });

  it('rejects future completions and malformed identities', () => {
    expect(
      engine.evaluate(
        {
          userId,
          sourceType: 'PRACTICE_COMPLETED',
          sourceId: '55555555-5555-4555-8555-555555555555',
          completedAt: new Date('2026-09-30T11:00:00.000Z'),
          status: 'COMPLETED',
          completedUnits: 1,
        },
        now,
      ),
    ).toMatchObject({ eligible: false, code: 'LEARNING_COMPLETION_IN_FUTURE' });

    expect(
      engine.evaluate(
        {
          userId: 'not-a-uuid',
          sourceType: 'PRACTICE_COMPLETED',
          sourceId: '55555555-5555-4555-8555-555555555555',
          completedAt: new Date('2026-09-30T09:00:00.000Z'),
          status: 'COMPLETED',
          completedUnits: 1,
        },
        now,
      ),
    ).toEqual({
      eligible: false,
      code: 'LEARNING_ACTIVITY_INVALID',
      reason: 'Learning activity identity or timestamp is invalid',
    });
  });
});
