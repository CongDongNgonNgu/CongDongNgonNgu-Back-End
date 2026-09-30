import { InMemoryReputationLedgerRepository } from './reputation.repository';
import { ContributionRuleEngine } from './reputation.rules';
import { ReputationService } from './reputation.service';
import { LearningXpRuleEngine } from './learning-xp.rules';
import { LearningXpService } from './learning-xp.service';
import type { ProfileRepository } from '../profile/profile.repository';

const userId = '11111111-1111-4111-8111-111111111111';
const otherUserId = '99999999-9999-4999-8999-999999999999';
const now = new Date('2026-10-02T12:00:00.000Z');

const sourceId = (value: number): string =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

function createService(timezone: string | null = 'Asia/Ho_Chi_Minh') {
  const repository = new InMemoryReputationLedgerRepository();
  const profiles = {
    findProfile: jest.fn().mockResolvedValue({ timezone }),
  } as unknown as ProfileRepository;
  const reputation = new ReputationService(repository, new ContributionRuleEngine());
  const learning = new LearningXpService(
    new LearningXpRuleEngine(),
    repository,
    reputation,
    profiles,
  );
  return { repository, profiles, learning };
}

describe('LearningXpService', () => {
  it('awards once per trusted completion and returns the existing entry on replay', async () => {
    const { learning, repository } = createService();
    const input = {
      userId,
      sourceType: 'PRACTICE_COMPLETED' as const,
      sourceId: sourceId(1),
      completedAt: new Date('2026-10-01T09:00:00.000Z'),
      status: 'COMPLETED' as const,
      completedUnits: 1,
    };

    const results = await Promise.all([
      learning.recordCompletion(input, now),
      learning.recordCompletion(input, now),
    ]);
    const first = results.find((result) => result.created)!;
    const replay = results.find((result) => !result.created)!;

    expect(first).toMatchObject({ created: true, entry: { delta: 20, system: 'learning_xp' } });
    expect(replay).toMatchObject({ created: false, entry: { id: first.entry!.id } });
    expect(await repository.getBalance(userId, 'learning_xp')).toBe(20);
  });

  it('does not write XP for failed, abandoned, or empty learning activity', async () => {
    const { learning, repository } = createService();
    const attempts = await Promise.all([
      learning.recordCompletion({
        userId,
        sourceType: 'PRACTICE_COMPLETED',
        sourceId: sourceId(2),
        completedAt: new Date('2026-10-01T09:00:00.000Z'),
        status: 'FAILED',
        completedUnits: 1,
      }, now),
      learning.recordCompletion({
        userId,
        sourceType: 'LEARNING_SESSION_COMPLETED',
        sourceId: sourceId(3),
        completedAt: new Date('2026-10-01T10:00:00.000Z'),
        status: 'ABANDONED',
        durationSeconds: 3600,
      }, now),
      learning.recordCompletion({
        userId,
        sourceType: 'PRACTICE_COMPLETED',
        sourceId: sourceId(4),
        completedAt: new Date('2026-10-01T11:00:00.000Z'),
        status: 'COMPLETED',
        completedUnits: 0,
      }, now),
    ]);

    expect(attempts.every((attempt) => attempt.entry === null && attempt.created === false)).toBe(true);
    expect(await repository.getBalance(userId, 'learning_xp')).toBe(0);
  });

  it('derives XP milestones, streak milestones, and local active days from immutable ledger entries', async () => {
    const { learning } = createService();
    const completionTimes = [
      '2026-09-29T16:59:00.000Z',
      '2026-09-29T17:01:00.000Z',
      '2026-09-30T16:01:00.000Z',
      '2026-10-01T15:01:00.000Z',
      '2026-10-01T16:01:00.000Z',
    ];

    for (const [index, completedAt] of completionTimes.entries()) {
      await learning.recordCompletion({
        userId,
        sourceType: 'PRACTICE_COMPLETED',
        sourceId: sourceId(10 + index),
        completedAt: new Date(completedAt),
        status: 'COMPLETED',
        completedUnits: 1,
      }, now);
    }

    const progress = await learning.getProgress(userId, new Date('2026-10-01T18:30:00.000Z'));

    expect(progress).toMatchObject({
      totalXp: 100,
      currentStreak: 3,
      longestStreak: 3,
      streakTimezone: 'Asia/Ho_Chi_Minh',
      activeDays: ['2026-09-29', '2026-09-30', '2026-10-01'],
    });
    expect(progress.milestones).toEqual(expect.arrayContaining([
      { kind: 'XP', threshold: 100, achievedOn: '2026-10-01' },
      { kind: 'STREAK', threshold: 3, achievedOn: '2026-10-01' },
    ]));
    expect(progress.recentQualifyingActivity).toHaveLength(5);
  });

  it('removes a reversed award from qualifying streak days while retaining immutable ledger history', async () => {
    const { learning, repository } = createService();
    const awarded = await learning.recordCompletion({
      userId,
      sourceType: 'PRACTICE_COMPLETED',
      sourceId: sourceId(30),
      completedAt: new Date('2026-10-01T09:00:00.000Z'),
      status: 'COMPLETED',
      completedUnits: 1,
    }, now);

    await learning.reverseCompletion({
      entryId: awarded.entry!.id,
      reason: 'Completion was invalidated',
      idempotencyKey: 'learning-reversal:30',
      createdAt: new Date('2026-10-02T09:00:00.000Z'),
    });

    const progress = await learning.getProgress(userId, now);
    const ledger = await repository.listByUser({ userId, system: 'learning_xp', limit: 100 });

    expect(progress.totalXp).toBe(0);
    expect(progress.activeDays).toEqual([]);
    expect(ledger).toHaveLength(2);
    expect(ledger.some((entry) => entry.reversalOfEntryId === awarded.entry!.id)).toBe(true);
  });

  it('keeps users isolated when projecting progress', async () => {
    const { learning } = createService(null);
    await learning.recordCompletion({
      userId: otherUserId,
      sourceType: 'LEARNING_SESSION_COMPLETED',
      sourceId: sourceId(40),
      completedAt: new Date('2026-10-01T09:00:00.000Z'),
      status: 'COMPLETED',
      durationSeconds: 60,
    }, now);

    const progress = await learning.getProgress(userId, now);
    expect(progress.totalXp).toBe(0);
    expect(progress.activeDays).toEqual([]);
  });

  it('keeps XP immutable when the profile timezone changes and does not create a new activity', async () => {
    const { learning, profiles, repository } = createService('UTC');
    await Promise.all([
      learning.recordCompletion({
        userId,
        sourceType: 'PRACTICE_COMPLETED',
        sourceId: sourceId(50),
        completedAt: new Date('2026-09-30T23:30:00.000Z'),
        status: 'COMPLETED',
        completedUnits: 1,
      }, now),
      learning.recordCompletion({
        userId,
        sourceType: 'PRACTICE_COMPLETED',
        sourceId: sourceId(51),
        completedAt: new Date('2026-10-01T00:30:00.000Z'),
        status: 'COMPLETED',
        completedUnits: 1,
      }, now),
    ]);

    const before = await learning.getProgress(userId, new Date('2026-10-01T12:00:00.000Z'));
    (profiles.findProfile as jest.Mock).mockResolvedValue({ timezone: 'America/Los_Angeles' });
    const after = await learning.getProgress(userId, new Date('2026-10-01T12:00:00.000Z'));
    const ledger = await repository.listByUser({ userId, system: 'learning_xp', limit: 100 });

    expect(before).toMatchObject({ totalXp: 40, activeDays: ['2026-09-30', '2026-10-01'] });
    expect(after).toMatchObject({ totalXp: 40, activeDays: ['2026-09-30'], streakTimezone: 'America/Los_Angeles' });
    expect(ledger).toHaveLength(2);
  });
});
