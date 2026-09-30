export const REPUTATION_SYSTEMS = [
  'learning_xp',
  'community_reputation',
] as const;

export type ReputationSystem = typeof REPUTATION_SYSTEMS[number];

export interface ReputationLedgerEntry {
  id: string;
  userId: string;
  system: ReputationSystem;
  sourceType: string;
  sourceId: string;
  delta: number;
  reason: string;
  ruleVersion: string;
  idempotencyKey: string;
  reversalOfEntryId: string | null;
  createdAt: Date;
}
