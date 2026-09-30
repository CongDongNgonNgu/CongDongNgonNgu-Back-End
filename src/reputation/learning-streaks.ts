export const DEFAULT_LEARNING_STREAK_TIMEZONE = 'UTC';

export class LearningStreakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LearningStreakError';
  }
}

export interface LearningStreakProjection {
  timezone: string;
  activeDays: string[];
  currentStreak: number;
  longestStreak: number;
  longestStreakEndedOn: string | null;
}

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export const resolveLearningTimezone = (timezone?: string | null): string => {
  if (typeof timezone !== 'string' || timezone.length === 0) {
    throw new LearningStreakError('LEARNING_TIMEZONE_INVALID');
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new LearningStreakError('LEARNING_TIMEZONE_INVALID');
  }

  return timezone;
};

export const learningLocalDateKey = (instant: Date, timezone: string): string => {
  if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) {
    throw new LearningStreakError('LEARNING_INSTANT_INVALID');
  }

  const resolvedTimezone = resolveLearningTimezone(timezone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: resolvedTimezone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));

  if (!values.year || !values.month || !values.day) {
    throw new LearningStreakError('LEARNING_LOCAL_DATE_INVALID');
  }

  return `${values.year}-${values.month}-${values.day}`;
};

const dateKeyToOrdinal = (dateKey: string): number => {
  const match = DATE_KEY_PATTERN.exec(dateKey);
  if (!match) throw new LearningStreakError('LEARNING_DATE_KEY_INVALID');

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ordinal = Date.UTC(year, month - 1, day) / 86_400_000;
  const roundTrip = new Date(ordinal * 86_400_000).toISOString().slice(0, 10);
  if (roundTrip !== dateKey) throw new LearningStreakError('LEARNING_DATE_KEY_INVALID');
  return ordinal;
};

const ordinalToDateKey = (ordinal: number): string =>
  new Date(ordinal * 86_400_000).toISOString().slice(0, 10);

export const previousLearningDateKey = (dateKey: string): string =>
  ordinalToDateKey(dateKeyToOrdinal(dateKey) - 1);

export const calculateLearningStreakFromDateKeys = (
  dateKeys: ReadonlyArray<string>,
  today: string,
  timezone: string,
): LearningStreakProjection => {
  const resolvedTimezone = resolveLearningTimezone(timezone);
  const uniqueActiveDays = [...new Set(dateKeys)].sort();
  uniqueActiveDays.forEach(dateKeyToOrdinal);
  dateKeyToOrdinal(today);

  let longestStreak = 0;
  let longestStreakEndedOn: string | null = null;
  let runLength = 0;
  let previousOrdinal: number | null = null;

  for (const dateKey of uniqueActiveDays) {
    const ordinal = dateKeyToOrdinal(dateKey);
    runLength = previousOrdinal !== null && ordinal === previousOrdinal + 1 ? runLength + 1 : 1;
    if (runLength > longestStreak) {
      longestStreak = runLength;
      longestStreakEndedOn = dateKey;
    }
    previousOrdinal = ordinal;
  }

  const activeSet = new Set(uniqueActiveDays);
  let currentStreak = 0;
  let cursor = today;
  if (!activeSet.has(cursor)) cursor = previousLearningDateKey(cursor);
  if (activeSet.has(cursor)) {
    while (activeSet.has(cursor)) {
      currentStreak += 1;
      cursor = previousLearningDateKey(cursor);
    }
  }

  return {
    timezone: resolvedTimezone,
    activeDays: uniqueActiveDays,
    currentStreak,
    longestStreak,
    longestStreakEndedOn,
  };
};

export const calculateLearningStreak = (
  instants: ReadonlyArray<Date>,
  timezone: string,
  now = new Date(),
): LearningStreakProjection => {
  const resolvedTimezone = resolveLearningTimezone(timezone);
  const today = learningLocalDateKey(now, resolvedTimezone);
  const dateKeys = instants.map((instant) => learningLocalDateKey(instant, resolvedTimezone));
  return calculateLearningStreakFromDateKeys(dateKeys, today, resolvedTimezone);
};
