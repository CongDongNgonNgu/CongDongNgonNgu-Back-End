import { randomUUID } from 'node:crypto';

export const LEARNING_XP_RULE_VERSION = 'learning-xp-v1';
export const MAX_LEARNING_XP_DELTA = 100;

export const LEARNING_XP_SOURCE_TYPES = [
  'PRACTICE_COMPLETED',
  'LEARNING_SESSION_COMPLETED',
  'VOCABULARY_MILESTONE',
  'QUIZ_MILESTONE',
] as const;

export type LearningXpSourceType = (typeof LEARNING_XP_SOURCE_TYPES)[number];

export const LEARNING_COMPLETION_STATUSES = ['COMPLETED', 'FAILED', 'ABANDONED'] as const;
export type LearningCompletionStatus = (typeof LEARNING_COMPLETION_STATUSES)[number];

export interface LearningCompletionInput {
  userId: string;
  sourceType: LearningXpSourceType;
  sourceId: string;
  completedAt: Date;
  status: LearningCompletionStatus;
  durationSeconds?: number;
  completedUnits?: number;
  milestoneNumber?: number;
  scorePercent?: number;
}

export type LearningXpIneligibilityCode =
  | 'LEARNING_ACTIVITY_INVALID'
  | 'LEARNING_COMPLETION_REQUIRED'
  | 'LEARNING_COMPLETION_IN_FUTURE'
  | 'LEARNING_EVIDENCE_INSUFFICIENT';

export interface LearningXpEligibleDecision {
  eligible: true;
  sourceType: LearningXpSourceType;
  sourceId: string;
  delta: number;
  reason: string;
  ruleVersion: string;
  idempotencyKey: string;
}

export interface LearningXpIneligibleDecision {
  eligible: false;
  code: LearningXpIneligibilityCode;
  reason: string;
}

export type LearningXpDecision = LearningXpEligibleDecision | LearningXpIneligibleDecision;

export interface LearningXpRuleDefinition {
  delta: number;
  reason: string;
  isEligible: (input: LearningCompletionInput) => boolean;
}

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const isBoundedPercent = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;

const isUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export const DEFAULT_LEARNING_XP_RULES: Readonly<Record<LearningXpSourceType, LearningXpRuleDefinition>> = {
  PRACTICE_COMPLETED: {
    delta: 20,
    reason: 'Completed a valid practice activity',
    isEligible: (input) => isPositiveInteger(input.completedUnits),
  },
  LEARNING_SESSION_COMPLETED: {
    delta: 10,
    reason: 'Completed a focused learning session',
    isEligible: (input) =>
      typeof input.durationSeconds === 'number' &&
      Number.isInteger(input.durationSeconds) &&
      input.durationSeconds >= 60,
  },
  VOCABULARY_MILESTONE: {
    delta: 10,
    reason: 'Reached a vocabulary milestone',
    isEligible: (input) => isPositiveInteger(input.milestoneNumber),
  },
  QUIZ_MILESTONE: {
    delta: 15,
    reason: 'Passed a quiz milestone',
    isEligible: (input) =>
      isBoundedPercent(input.scorePercent) &&
      input.scorePercent >= 60,
  },
};

export class LearningXpRuleEngine {
  constructor(
    private readonly rules: Readonly<Record<LearningXpSourceType, LearningXpRuleDefinition>> =
      DEFAULT_LEARNING_XP_RULES,
  ) {}

  evaluate(input: LearningCompletionInput, now = new Date()): LearningXpDecision {
    if (
      !isUuid(input.userId) ||
      !isUuid(input.sourceId) ||
      !LEARNING_XP_SOURCE_TYPES.includes(input.sourceType) ||
      !LEARNING_COMPLETION_STATUSES.includes(input.status) ||
      !(input.completedAt instanceof Date) ||
      !Number.isFinite(input.completedAt.getTime()) ||
      !(now instanceof Date) ||
      !Number.isFinite(now.getTime())
    ) {
      return {
        eligible: false,
        code: 'LEARNING_ACTIVITY_INVALID',
        reason: 'Learning activity identity or timestamp is invalid',
      };
    }

    if (input.completedAt.getTime() > now.getTime()) {
      return {
        eligible: false,
        code: 'LEARNING_COMPLETION_IN_FUTURE',
        reason: 'Learning completion cannot be recorded before it occurs',
      };
    }

    if (input.status !== 'COMPLETED') {
      return {
        eligible: false,
        code: 'LEARNING_COMPLETION_REQUIRED',
        reason: 'Only completed learning activities earn XP',
      };
    }

    const rule = this.rules[input.sourceType];
    if (
      !rule ||
      !rule.isEligible(input) ||
      !Number.isSafeInteger(rule.delta) ||
      rule.delta <= 0 ||
      rule.delta > MAX_LEARNING_XP_DELTA
    ) {
      return {
        eligible: false,
        code: 'LEARNING_EVIDENCE_INSUFFICIENT',
        reason: 'Learning completion evidence does not meet the bounded XP rule',
      };
    }

    return {
      eligible: true,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      delta: rule.delta,
      reason: rule.reason,
      ruleVersion: LEARNING_XP_RULE_VERSION,
      idempotencyKey: `learning:${input.sourceType}:${input.sourceId}`,
    };
  }
}

export const createLearningSourceId = (): string => randomUUID();
