import {
  calculateLearningStreak,
  calculateLearningStreakFromDateKeys,
  learningLocalDateKey,
  resolveLearningTimezone,
} from './learning-streaks';

describe('learning streak calculation', () => {
  it('deduplicates same-day activity and handles local midnight boundaries', () => {
    const timezone = 'Asia/Ho_Chi_Minh';
    const projection = calculateLearningStreak(
      [
        new Date('2026-09-29T16:59:00.000Z'),
        new Date('2026-09-29T17:01:00.000Z'),
        new Date('2026-09-29T18:30:00.000Z'),
        new Date('2026-09-30T17:01:00.000Z'),
      ],
      timezone,
      new Date('2026-10-01T05:00:00.000Z'),
    );

    expect(projection).toMatchObject({
      timezone,
      activeDays: ['2026-09-29', '2026-09-30', '2026-10-01'],
      currentStreak: 3,
      longestStreak: 3,
      longestStreakEndedOn: '2026-10-01',
    });
  });

  it('keeps current streak at zero after a missed day while preserving longest history', () => {
    const projection = calculateLearningStreakFromDateKeys(
      ['2026-09-01', '2026-09-02', '2026-09-04', '2026-09-05'],
      '2026-09-07',
      'UTC',
    );

    expect(projection).toMatchObject({ currentStreak: 0, longestStreak: 2, longestStreakEndedOn: '2026-09-02' });
  });

  it('is deterministic for out-of-order and repeated ledger events', () => {
    const now = new Date('2026-09-05T12:00:00.000Z');
    const first = calculateLearningStreak(
      [
        new Date('2026-09-04T08:00:00.000Z'),
        new Date('2026-09-02T08:00:00.000Z'),
        new Date('2026-09-04T22:00:00.000Z'),
        new Date('2026-09-03T08:00:00.000Z'),
      ],
      'UTC',
      now,
    );
    const second = calculateLearningStreak(
      [
        new Date('2026-09-03T08:00:00.000Z'),
        new Date('2026-09-04T22:00:00.000Z'),
        new Date('2026-09-02T08:00:00.000Z'),
        new Date('2026-09-04T08:00:00.000Z'),
      ],
      'UTC',
      now,
    );

    expect(second).toEqual(first);
    expect(first.currentStreak).toBe(3);
  });

  it('uses explicit learner timezone rather than process timezone', () => {
    const instant = new Date('2026-09-30T16:30:00.000Z');
    expect(learningLocalDateKey(instant, 'Asia/Ho_Chi_Minh')).toBe('2026-09-30');
    expect(learningLocalDateKey(instant, 'America/New_York')).toBe('2026-09-30');
    expect(learningLocalDateKey(instant, 'UTC')).toBe('2026-09-30');
    expect(learningLocalDateKey(new Date('2026-10-01T00:30:00.000Z'), 'UTC')).toBe('2026-10-01');
    expect(learningLocalDateKey(new Date('2026-10-01T00:30:00.000Z'), 'America/Los_Angeles')).toBe('2026-09-30');
  });

  it('handles DST calendar days without using elapsed 24-hour windows', () => {
    const projection = calculateLearningStreak(
      [
        new Date('2026-03-08T06:30:00.000Z'),
        new Date('2026-03-09T05:30:00.000Z'),
      ],
      'America/New_York',
      new Date('2026-03-09T12:00:00.000Z'),
    );

    expect(projection.activeDays).toEqual(['2026-03-08', '2026-03-09']);
    expect(projection.currentStreak).toBe(2);
  });

  it('rejects timezone-less input and invalid timezone identifiers', () => {
    expect(() => resolveLearningTimezone(null)).toThrow('LEARNING_TIMEZONE_INVALID');
    expect(() => resolveLearningTimezone(undefined)).toThrow('LEARNING_TIMEZONE_INVALID');
    expect(() => resolveLearningTimezone('')).toThrow('LEARNING_TIMEZONE_INVALID');
    expect(() => resolveLearningTimezone('Not/A_Timezone')).toThrow('LEARNING_TIMEZONE_INVALID');
  });

  it('rejects invalid date keys and invalid instants', () => {
    expect(() => calculateLearningStreakFromDateKeys(['2026-02-30'], '2026-03-01', 'UTC')).toThrow(
      'LEARNING_DATE_KEY_INVALID',
    );
    expect(() => calculateLearningStreak([new Date('invalid')], 'UTC')).toThrow('LEARNING_INSTANT_INVALID');
  });
});
