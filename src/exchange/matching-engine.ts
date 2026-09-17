import type {
  AvailabilityWindowRecord,
  ProfileRecord,
  UserLanguageRecord,
} from '../profile/profile.types';
import type { ExchangePreferenceRecord } from './exchange.types';

const WEEK_MINUTES = 7 * 24 * 60;
const MAX_TIMEZONE_DISTANCE_MINUTES = 12 * 60;
const COMPATIBLE_TIMEZONE_DISTANCE_MINUTES = 3 * 60;
const MATCHING_REFERENCE_DATE = new Date('2026-01-15T12:00:00.000Z');

export interface MatchingParticipant {
  userId: string;
  preferences: ExchangePreferenceRecord;
  profile: ProfileRecord;
}

export interface MatchingWeights {
  reciprocalLanguage: number;
  levelCompatibility: number;
  timezoneAvailability: number;
  sharedGoalsInterests: number;
}

export const DEFAULT_MATCHING_WEIGHTS: Readonly<MatchingWeights> = Object.freeze({
  reciprocalLanguage: 0.5,
  levelCompatibility: 0.2,
  timezoneAvailability: 0.2,
  sharedGoalsInterests: 0.1,
});

export interface MatchingSignals {
  forwardLanguageCodes: string[];
  backwardLanguageCodes: string[];
  levelCompatibility: number | null;
  timezoneOffsetDifferenceMinutes: number | null;
  timezoneCompatible: boolean | null;
  availabilityOverlap: boolean | null;
  sharedGoalCodes: string[];
  sharedInterestCodes: string[];
}

export interface MatchingResult {
  normalizedScore: number;
  reasons: string[];
  signals: MatchingSignals;
}

export function evaluateMatch(
  viewer: MatchingParticipant,
  candidate: MatchingParticipant,
  weights: MatchingWeights = DEFAULT_MATCHING_WEIGHTS,
): MatchingResult | null {
  assertWeights(weights);
  if (viewer.userId === candidate.userId) return null;

  const forwardLanguageCodes = intersectExchangeLanguages(
    viewer.preferences.wantedLanguageCodes,
    candidate.preferences.offeredLanguageCodes,
    candidate.profile,
  );
  const backwardLanguageCodes = intersectExchangeLanguages(
    candidate.preferences.wantedLanguageCodes,
    viewer.preferences.offeredLanguageCodes,
    viewer.profile,
  );
  if (forwardLanguageCodes.length === 0 || backwardLanguageCodes.length === 0) return null;

  const levelCompatibility = calculateLevelCompatibility(
    viewer.preferences.preferredPartnerLevels,
    candidate.preferences.preferredPartnerLevels,
    forwardLanguageCodes,
    backwardLanguageCodes,
    viewer.profile,
    candidate.profile,
  );
  const timeCompatibility = calculateTimeCompatibility(viewer.profile, candidate.profile);
  const shared = calculateSharedTopics(viewer.preferences, candidate.preferences);
  const signals: MatchingSignals = {
    forwardLanguageCodes,
    backwardLanguageCodes,
    levelCompatibility,
    timezoneOffsetDifferenceMinutes: timeCompatibility.timezoneOffsetDifferenceMinutes,
    timezoneCompatible: timeCompatibility.timezoneCompatible,
    availabilityOverlap: timeCompatibility.availabilityOverlap,
    sharedGoalCodes: shared.goalCodes,
    sharedInterestCodes: shared.interestCodes,
  };

  const components: Array<{ value: number | null; weight: number }> = [
    { value: reciprocalLanguageScore(forwardLanguageCodes, backwardLanguageCodes), weight: weights.reciprocalLanguage },
    { value: levelCompatibility, weight: weights.levelCompatibility },
    { value: timeCompatibility.score, weight: weights.timezoneAvailability },
    { value: shared.score, weight: weights.sharedGoalsInterests },
  ];
  const activeComponents = components.filter((component) => component.value !== null && component.weight > 0);
  const totalWeight = activeComponents.reduce((sum, component) => sum + component.weight, 0);
  const weightedScore = totalWeight === 0
    ? 0
    : activeComponents.reduce((sum, component) => sum + component.value! * component.weight, 0) / totalWeight;

  return {
    normalizedScore: roundScore(weightedScore),
    reasons: buildReasons(
      viewer.profile,
      candidate.profile,
      forwardLanguageCodes,
      backwardLanguageCodes,
      levelCompatibility,
      timeCompatibility,
      shared,
    ),
    signals,
  };
}

export function rankMatches<T extends { userId: string; match: { normalizedScore: number } }>(
  matches: readonly T[],
): T[] {
  return [...matches].sort((left, right) => (
    right.match.normalizedScore - left.match.normalizedScore
      || compareStableIds(left.userId, right.userId)
  ));
}

function compareStableIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function intersectExchangeLanguages(
  wantedCodes: readonly string[],
  offeredCodes: readonly string[],
  profile: ProfileRecord,
): string[] {
  const offered = new Set(offeredCodes);
  const publicProfileCodes = new Set(
    profile.languages
      .filter((language) => language.visibility === 'PUBLIC')
      .map((language) => language.language.code),
  );
  return [...new Set(wantedCodes)]
    .filter((code) => offered.has(code) && publicProfileCodes.has(code))
    .sort((left, right) => left.localeCompare(right));
}

function reciprocalLanguageScore(forward: readonly string[], backward: readonly string[]): number {
  return Math.min(1, (forward.length + backward.length) / 2);
}

function calculateLevelCompatibility(
  viewerPreferredLevels: readonly string[],
  candidatePreferredLevels: readonly string[],
  forwardCodes: readonly string[],
  backwardCodes: readonly string[],
  viewerProfile: ProfileRecord,
  candidateProfile: ProfileRecord,
): number | null {
  const directionalScores: number[] = [];
  if (viewerPreferredLevels.length > 0) {
    directionalScores.push(scoreRelationsAgainstLevels(
      forwardCodes,
      candidateProfile,
      viewerPreferredLevels,
    ));
  }
  if (candidatePreferredLevels.length > 0) {
    directionalScores.push(scoreRelationsAgainstLevels(
      backwardCodes,
      viewerProfile,
      candidatePreferredLevels,
    ));
  }
  if (directionalScores.length === 0) return null;
  return directionalScores.reduce((sum, score) => sum + score, 0) / directionalScores.length;
}

function scoreRelationsAgainstLevels(
  codes: readonly string[],
  profile: ProfileRecord,
  preferredLevels: readonly string[],
): number {
  const preferred = new Set(preferredLevels);
  const relations = codes
    .map((code) => profile.languages.find((language) => language.language.code === code))
    .filter((language): language is UserLanguageRecord => Boolean(language));
  if (relations.length === 0) return 0;
  return relations.some((relation) => (
    relation.declaredProficiency === 'NATIVE'
      || preferred.has(relation.assessedProficiency ?? relation.declaredProficiency)
  )) ? 1 : 0;
}

function calculateTimeCompatibility(
  viewerProfile: ProfileRecord,
  candidateProfile: ProfileRecord,
): {
  score: number | null;
  timezoneOffsetDifferenceMinutes: number | null;
  timezoneCompatible: boolean | null;
  availabilityOverlap: boolean | null;
} {
  const viewerOffset = viewerProfile.timezone ? timezoneOffsetMinutes(viewerProfile.timezone) : null;
  const candidateOffset = candidateProfile.timezone ? timezoneOffsetMinutes(candidateProfile.timezone) : null;
  const timezoneOffsetDifferenceMinutes = viewerOffset === null || candidateOffset === null
    ? null
    : Math.abs(viewerOffset - candidateOffset);
  const timezoneScore = timezoneOffsetDifferenceMinutes === null
    ? null
    : Math.max(0, 1 - timezoneOffsetDifferenceMinutes / MAX_TIMEZONE_DISTANCE_MINUTES);
  const availabilityOverlap = viewerProfile.availability.length > 0 && candidateProfile.availability.length > 0
    ? hasAvailabilityOverlap(
        viewerProfile.availability,
        candidateProfile.availability,
        viewerOffset ?? 0,
        candidateOffset ?? 0,
      )
    : null;
  const scores = [timezoneScore, availabilityOverlap === null ? null : availabilityOverlap ? 1 : 0]
    .filter((score): score is number => score !== null);
  return {
    score: scores.length > 0 ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
    timezoneOffsetDifferenceMinutes,
    timezoneCompatible: timezoneOffsetDifferenceMinutes === null
      ? null
      : timezoneOffsetDifferenceMinutes <= COMPATIBLE_TIMEZONE_DISTANCE_MINUTES,
    availabilityOverlap,
  };
}

function timezoneOffsetMinutes(timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(MATCHING_REFERENCE_DATE);
    const value = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
    if (value === 'GMT' || value === 'UTC') return 0;
    const match = value.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
    if (!match) return null;
    const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
    return (match[1] === '-' ? -1 : 1) * minutes;
  } catch {
    return null;
  }
}

function hasAvailabilityOverlap(
  viewerWindows: readonly AvailabilityWindowRecord[],
  candidateWindows: readonly AvailabilityWindowRecord[],
  viewerOffset: number,
  candidateOffset: number,
): boolean {
  const viewerSegments = viewerWindows.flatMap((window) => toUtcSegments(window, viewerOffset));
  const candidateSegments = candidateWindows.flatMap((window) => toUtcSegments(window, candidateOffset));
  return viewerSegments.some(([viewerStart, viewerEnd]) => candidateSegments.some(([candidateStart, candidateEnd]) => (
    viewerStart < candidateEnd && candidateStart < viewerEnd
  )));
}

function toUtcSegments(
  window: AvailabilityWindowRecord,
  offsetMinutes: number,
): Array<[number, number]> {
  if (
    !Number.isInteger(window.dayOfWeek) || window.dayOfWeek < 1 || window.dayOfWeek > 7
    || !Number.isInteger(window.startMinute) || !Number.isInteger(window.endMinute)
    || window.startMinute < 0 || window.endMinute > 1440 || window.startMinute >= window.endMinute
  ) {
    return [];
  }
  const start = (window.dayOfWeek - 1) * 1440 + window.startMinute - offsetMinutes;
  const end = (window.dayOfWeek - 1) * 1440 + window.endMinute - offsetMinutes;
  const normalizedStart = modulo(start, WEEK_MINUTES);
  const normalizedEnd = modulo(end, WEEK_MINUTES);
  if (normalizedStart < normalizedEnd) return [[normalizedStart, normalizedEnd]];
  return [[normalizedStart, WEEK_MINUTES], [0, normalizedEnd]];
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function calculateSharedTopics(
  viewerPreferences: ExchangePreferenceRecord,
  candidatePreferences: ExchangePreferenceRecord,
): {
  score: number | null;
  goalCodes: string[];
  interestCodes: string[];
} {
  const goalCodes = intersection(viewerPreferences.matchingGoalCodes, candidatePreferences.matchingGoalCodes);
  const interestCodes = intersection(viewerPreferences.matchingInterestCodes, candidatePreferences.matchingInterestCodes);
  const scores: number[] = [];
  if (viewerPreferences.matchingGoalCodes.length > 0 && candidatePreferences.matchingGoalCodes.length > 0) {
    scores.push(goalCodes.length / Math.min(
      viewerPreferences.matchingGoalCodes.length,
      candidatePreferences.matchingGoalCodes.length,
    ));
  }
  if (viewerPreferences.matchingInterestCodes.length > 0 && candidatePreferences.matchingInterestCodes.length > 0) {
    scores.push(interestCodes.length / Math.min(
      viewerPreferences.matchingInterestCodes.length,
      candidatePreferences.matchingInterestCodes.length,
    ));
  }
  return {
    score: scores.length > 0 ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
    goalCodes,
    interestCodes,
  };
}

function intersection(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return [...new Set(left)].filter((value) => rightSet.has(value)).sort((a, b) => a.localeCompare(b));
}

function buildReasons(
  viewerProfile: ProfileRecord,
  candidateProfile: ProfileRecord,
  forwardCodes: readonly string[],
  backwardCodes: readonly string[],
  levelCompatibility: number | null,
  timeCompatibility: ReturnType<typeof calculateTimeCompatibility>,
  shared: ReturnType<typeof calculateSharedTopics>,
): string[] {
  const reasons: string[] = [];
  const viewerByCode = new Map(viewerProfile.languages.map((language) => [language.language.code, language]));
  const candidateByCode = new Map(candidateProfile.languages.map((language) => [language.language.code, language]));
  for (const code of forwardCodes) {
    const viewerLanguage = viewerByCode.get(code)?.language.englishName ?? code;
    const candidateLanguage = candidateByCode.get(code)?.language.englishName ?? code;
    reasons.push(`Họ có thể hỗ trợ ${candidateLanguage}; bạn đang muốn học ${viewerLanguage}.`);
  }
  for (const code of backwardCodes) {
    const viewerLanguage = viewerByCode.get(code)?.language.englishName ?? code;
    const candidateLanguage = candidateByCode.get(code)?.language.englishName ?? code;
    reasons.push(`Bạn có thể hỗ trợ ${viewerLanguage}; họ đang muốn học ${candidateLanguage}.`);
  }
  if (levelCompatibility !== null && levelCompatibility > 0) {
    reasons.push('Mức độ bạn chọn tương thích với hồ sơ ngôn ngữ của nhau.');
  }
  if (timeCompatibility.timezoneCompatible) {
    reasons.push('Múi giờ tương thích.');
  }
  if (timeCompatibility.availabilityOverlap) {
    reasons.push('Có khoảng thời gian học phù hợp.');
  }
  if (shared.goalCodes.length > 0) {
    reasons.push(`Mục tiêu chung: ${shared.goalCodes.join(', ')}.`);
  }
  if (shared.interestCodes.length > 0) {
    reasons.push(`Sở thích chung: ${shared.interestCodes.join(', ')}.`);
  }
  return reasons;
}

function assertWeights(weights: MatchingWeights): void {
  const values = Object.values(weights);
  if (values.some((value) => !Number.isFinite(value) || value < 0) || values.every((value) => value === 0)) {
    throw new Error('Matching weights must be finite, non-negative, and non-zero in total');
  }
}

function roundScore(score: number): number {
  return Math.round(Math.max(0, Math.min(1, score)) * 10000) / 10000;
}
