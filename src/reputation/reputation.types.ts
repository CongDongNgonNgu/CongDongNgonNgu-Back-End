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

/**
 * Server-derived facts supplied to the anti-farming boundary.
 *
 * The fingerprint is optional so existing domain integrations can adopt the
 * contract incrementally. The ledger remains the source of truth for replay
 * protection and reversals.
 */
export interface ContributionEventFact {
  contributorUserId: string;
  actorUserId: string | null;
  sourceType: ReputationSourceType;
  sourceId: string;
  sourceFingerprint?: string | null;
  occurredAt: Date;
}

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
