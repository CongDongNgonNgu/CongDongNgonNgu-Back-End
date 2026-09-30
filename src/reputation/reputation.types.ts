export const REPUTATION_SYSTEMS = [
  'learning_xp',
  'community_reputation',
] as const;

export type ReputationSystem = typeof REPUTATION_SYSTEMS[number];

export const REPUTATION_SOURCE_TYPES = [
  'USEFUL_ANSWER_ACCEPTED',
  'CORRECTION_ACCEPTED',
  'TRANSLATION_VERIFIED',
  'RESOURCE_VERIFIED',
  'REVIEW_VERIFICATION',
  'PRACTICE_COMPLETED',
  'LEARNING_SESSION_COMPLETED',
  'VOCABULARY_MILESTONE',
  'QUIZ_MILESTONE',
] as const;

export type ReputationSourceType = typeof REPUTATION_SOURCE_TYPES[number];

export interface ReputationLedgerEntry {
  id: string;
  userId: string;
  system: ReputationSystem;
  sourceType: ReputationSourceType;
  sourceId: string;
  delta: number;
  reason: string;
  ruleVersion: string;
  idempotencyKey: string;
  reversalOfEntryId: string | null;
  createdAt: Date;
}
