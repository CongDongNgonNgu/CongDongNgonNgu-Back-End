export const CHALLENGE_TYPES = [
  'SPEAKING',
  'SENTENCE_PRACTICE',
  'PRONUNCIATION',
  'VOCABULARY',
  'COMMUNITY',
] as const;
export type ChallengeType = (typeof CHALLENGE_TYPES)[number];

export const CHALLENGE_GOAL_UNITS = ['ACTIVITIES', 'MINUTES', 'ITEMS'] as const;
export type ChallengeGoalUnit = (typeof CHALLENGE_GOAL_UNITS)[number];

export const CHALLENGE_ACTIVITY_TYPES = [
  'SPEAKING_ROOM_ATTENDANCE',
  'PRACTICE_COMPLETED',
  'VOCABULARY_MILESTONE',
  'COMMUNITY_CONTRIBUTION',
] as const;
export type ChallengeActivityType = (typeof CHALLENGE_ACTIVITY_TYPES)[number];

export const CHALLENGE_STATUSES = ['DRAFT', 'ACTIVE', 'CANCELLED'] as const;
export type ChallengeStatus = (typeof CHALLENGE_STATUSES)[number];

export const CHALLENGE_PARTICIPATION_STATUSES = ['JOINED', 'LEFT', 'COMPLETED'] as const;
export type ChallengeParticipationStatus = (typeof CHALLENGE_PARTICIPATION_STATUSES)[number];

export interface ChallengeGoal {
  unit: ChallengeGoalUnit;
  target: number;
}

export interface ChallengeRewardDefinition {
  eventType: string;
  ruleVersion: string;
}

export interface ChallengeRecord {
  id: string;
  createdByUserId: string | null;
  title: string;
  description: string;
  challengeType: ChallengeType;
  languageCode: string;
  level: string | null;
  topic: string | null;
  startAt: Date;
  endAt: Date;
  timezone: string;
  goal: ChallengeGoal;
  eligibleActivityTypes: ChallengeActivityType[];
  ruleVersion: string;
  reward: ChallengeRewardDefinition | null;
  status: ChallengeStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChallengeParticipationRecord {
  id: string;
  challengeId: string;
  userId: string;
  status: ChallengeParticipationStatus;
  joinedAt: Date;
  leftAt: Date | null;
  completedAt: Date | null;
  progressValue: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChallengeProgressEventRecord {
  id: string;
  challengeId: string;
  userId: string;
  activityType: ChallengeActivityType;
  sourceId: string;
  units: number;
  occurredAt: Date;
  ruleVersion: string;
  idempotencyKey: string;
  fingerprint: string;
  createdAt: Date;
}

export interface ChallengeCompletionRewardEvent {
  eventType: string;
  challengeId: string;
  userId: string;
  ruleVersion: string;
  occurredAt: Date;
}

export interface ChallengeProgressProjection {
  challengeId: string;
  userId: string;
  status: ChallengeParticipationStatus;
  progressValue: number;
  goal: ChallengeGoal;
  completionPercent: number;
  completedAt: Date | null;
  rewardEvent: ChallengeCompletionRewardEvent | null;
}

export interface ChallengeActivityInput {
  challenge: ChallengeRecord;
  userId: string;
  activityType: ChallengeActivityType;
  sourceId: string;
  units: number;
  occurredAt: Date;
}
