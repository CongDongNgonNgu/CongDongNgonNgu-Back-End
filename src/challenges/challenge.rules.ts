import { createHash } from 'node:crypto';
import {
  CHALLENGE_ACTIVITY_TYPES,
  CHALLENGE_GOAL_UNITS,
  CHALLENGE_STATUSES,
  CHALLENGE_TYPES,
  type ChallengeActivityInput,
  type ChallengeActivityType,
  type ChallengeRecord,
  type ChallengeRewardDefinition,
  type ChallengeStatus,
  type ChallengeType,
  type ChallengeGoalUnit,
} from './challenge.types';

export const CHALLENGE_RULE_VERSION = 'challenge-progress-v1';
export const MAX_CHALLENGE_TITLE_LENGTH = 160;
export const MAX_CHALLENGE_DESCRIPTION_LENGTH = 2_000;
export const MAX_CHALLENGE_ACTIVITY_UNITS = 1_000;

export interface CreateChallengeDefinitionInput {
  title: string;
  description: string;
  challengeType: ChallengeType;
  languageCode: string;
  level?: string | null;
  topic?: string | null;
  startAt: Date;
  endAt: Date;
  timezone: string;
  goalUnit: ChallengeGoalUnit;
  goalTarget: number;
  eligibleActivityTypes: readonly ChallengeActivityType[];
  ruleVersion: string;
  reward?: ChallengeRewardDefinition | null;
  createdByUserId?: string | null;
  status?: ChallengeStatus;
  createdAt: Date;
}

export interface NormalizedChallengeDefinition extends Omit<ChallengeRecord, 'id'> {
  id?: string;
}

export type ChallengeProgressDecision =
  | {
      eligible: true;
      userId: string;
      activityType: ChallengeActivityType;
      sourceId: string;
      units: number;
      occurredAt: Date;
      ruleVersion: string;
      idempotencyKey: string;
      fingerprint: string;
    }
  | {
      eligible: false;
      code:
        | 'CHALLENGE_ACTIVITY_INVALID'
        | 'CHALLENGE_ACTIVITY_NOT_ELIGIBLE'
        | 'CHALLENGE_NOT_ACTIVE'
        | 'CHALLENGE_EXPIRED'
        | 'CHALLENGE_ACTIVITY_IN_FUTURE';
      reason: string;
    };

export interface ChallengeProgressIdentity {
  idempotencyKey: string;
  fingerprint: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const LANGUAGE_CODE_PATTERN = /^[a-z]{2,35}$/u;
const SAFE_RULE_VERSION_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/u;
const SAFE_REWARD_EVENT_PATTERN = /^[a-z][a-z0-9._:-]{2,95}$/u;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const LEVELS = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);

export function normalizeChallengeDefinition(
  input: CreateChallengeDefinitionInput,
): NormalizedChallengeDefinition {
  const title = normalizeText(input.title, 3, MAX_CHALLENGE_TITLE_LENGTH, 'Challenge title is invalid');
  const description = normalizeText(
    input.description,
    1,
    MAX_CHALLENGE_DESCRIPTION_LENGTH,
    'Challenge description is invalid',
  );
  const languageCode = typeof input.languageCode === 'string'
    ? input.languageCode.trim().toLowerCase()
    : '';
  if (!LANGUAGE_CODE_PATTERN.test(languageCode)) throw new Error('Challenge language is invalid');
  if (!CHALLENGE_TYPES.includes(input.challengeType)) throw new Error('Challenge type is invalid');
  if (input.level !== undefined && input.level !== null && !LEVELS.has(input.level)) {
    throw new Error('Challenge level is invalid');
  }
  const topic = input.topic === undefined || input.topic === null
    ? null
    : normalizeText(input.topic, 1, 80, 'Challenge topic is invalid');
  if (!isValidDate(input.startAt) || !isValidDate(input.endAt) || input.endAt.getTime() <= input.startAt.getTime()) {
    throw new Error('Challenge schedule is invalid');
  }
  if (!isIanaTimezone(input.timezone)) throw new Error('Challenge timezone is invalid');
  if (!CHALLENGE_GOAL_UNITS.includes(input.goalUnit) || !isBoundedPositiveInteger(input.goalTarget, 1_000_000)) {
    throw new Error('Challenge goal is invalid');
  }
  const eligibleActivityTypes = normalizeActivityTypes(input.eligibleActivityTypes);
  if (!SAFE_RULE_VERSION_PATTERN.test(input.ruleVersion)) {
    throw new Error('Challenge rule version is invalid');
  }
  const reward = normalizeReward(input.reward);
  const createdByUserId = input.createdByUserId ?? null;
  if (createdByUserId !== null && !UUID_PATTERN.test(createdByUserId)) {
    throw new Error('Challenge owner is invalid');
  }
  const status = input.status ?? 'ACTIVE';
  if (!CHALLENGE_STATUSES.includes(status)) throw new Error('Challenge status is invalid');
  if (!isValidDate(input.createdAt)) throw new Error('Challenge creation time is invalid');

  return {
    id: undefined,
    createdByUserId,
    title,
    description,
    challengeType: input.challengeType,
    languageCode,
    level: input.level ?? null,
    topic,
    startAt: new Date(input.startAt),
    endAt: new Date(input.endAt),
    timezone: input.timezone.trim(),
    goal: { unit: input.goalUnit, target: input.goalTarget },
    eligibleActivityTypes,
    ruleVersion: input.ruleVersion,
    reward,
    status,
    createdAt: new Date(input.createdAt),
    updatedAt: new Date(input.createdAt),
  };
}

export function createChallengeProgressIdentity(
  input: ChallengeActivityInput,
): ChallengeProgressIdentity | null {
  if (
    !UUID_PATTERN.test(input.challenge.id) ||
    !UUID_PATTERN.test(input.userId) ||
    !isValidDate(input.occurredAt) ||
    !CHALLENGE_ACTIVITY_TYPES.includes(input.activityType) ||
    !SOURCE_ID_PATTERN.test(input.sourceId) ||
    !isBoundedPositiveInteger(input.units, MAX_CHALLENGE_ACTIVITY_UNITS)
  ) {
    return null;
  }

  const idempotencyKey = [
    'challenge',
    input.challenge.id,
    input.activityType,
    input.sourceId,
  ].join(':');
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({
      challengeId: input.challenge.id,
      userId: input.userId,
      activityType: input.activityType,
      sourceId: input.sourceId,
      units: input.units,
      occurredAt: input.occurredAt.toISOString(),
      ruleVersion: input.challenge.ruleVersion,
    }))
    .digest('hex');
  return { idempotencyKey, fingerprint };
}

export class ChallengeRuleEngine {
  evaluateProgress(input: ChallengeActivityInput, now = new Date()): ChallengeProgressDecision {
    const identity = createChallengeProgressIdentity(input);
    if (!identity || !isValidDate(now)) {
      return {
        eligible: false,
        code: 'CHALLENGE_ACTIVITY_INVALID',
        reason: 'Challenge activity evidence is invalid',
      };
    }
    if (input.challenge.status !== 'ACTIVE') {
      return {
        eligible: false,
        code: 'CHALLENGE_NOT_ACTIVE',
        reason: 'Challenge is not accepting progress',
      };
    }
    if (input.occurredAt.getTime() > now.getTime()) {
      return {
        eligible: false,
        code: 'CHALLENGE_ACTIVITY_IN_FUTURE',
        reason: 'Challenge activity cannot be recorded before it occurs',
      };
    }
    if (now.getTime() >= input.challenge.endAt.getTime() || input.occurredAt.getTime() >= input.challenge.endAt.getTime()) {
      return {
        eligible: false,
        code: 'CHALLENGE_EXPIRED',
        reason: 'Challenge activity window has ended',
      };
    }
    if (
      input.occurredAt.getTime() < input.challenge.startAt.getTime() ||
      !input.challenge.eligibleActivityTypes.includes(input.activityType)
    ) {
      return {
        eligible: false,
        code: 'CHALLENGE_ACTIVITY_NOT_ELIGIBLE',
        reason: 'Challenge activity does not match the configured rule',
      };
    }

    return {
      eligible: true,
      userId: input.userId,
      activityType: input.activityType,
      sourceId: input.sourceId,
      units: input.units,
      occurredAt: new Date(input.occurredAt),
      ruleVersion: input.challenge.ruleVersion,
      ...identity,
    };
  }
}

function normalizeText(value: string, min: number, max: number, message: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length < min || normalized.length > max) throw new Error(message);
  return normalized;
}

function normalizeActivityTypes(values: readonly ChallengeActivityType[]): ChallengeActivityType[] {
  const unique = [...new Set(values)];
  if (
    unique.length === 0 ||
    unique.length > 8 ||
    unique.some((value) => !CHALLENGE_ACTIVITY_TYPES.includes(value))
  ) {
    throw new Error('Challenge activity rules are invalid');
  }
  return unique;
}

function normalizeReward(value: ChallengeRewardDefinition | null | undefined): ChallengeRewardDefinition | null {
  if (value === undefined || value === null) return null;
  if (!SAFE_REWARD_EVENT_PATTERN.test(value.eventType) || !SAFE_RULE_VERSION_PATTERN.test(value.ruleVersion)) {
    throw new Error('Challenge reward rule is invalid');
  }
  return { eventType: value.eventType, ruleVersion: value.ruleVersion };
}

function isBoundedPositiveInteger(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isIanaTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).format();
    return true;
  } catch {
    return false;
  }
}
