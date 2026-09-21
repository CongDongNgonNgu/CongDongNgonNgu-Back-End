import type { PoolClient } from 'pg';

export const EXCHANGE_REPORT_CATEGORIES = [
  'SPAM',
  'HARASSMENT',
  'INAPPROPRIATE_CONTENT',
  'IMPERSONATION',
  'SAFETY_CONCERN',
  'OTHER',
] as const;

export type ExchangeReportCategory = typeof EXCHANGE_REPORT_CATEGORIES[number];

export type ExchangeBlockMutationOutcome =
  | 'CREATED'
  | 'ALREADY_BLOCKED'
  | 'REMOVED'
  | 'NOT_BLOCKED';

export type ExchangeRelationshipRemovalMode = 'ATOMIC' | 'DEFERRED';

export interface ExchangeBlockMutationResult {
  targetUserId: string;
  outcome: ExchangeBlockMutationOutcome;
  relationshipRemoval?: ExchangeRelationshipRemovalMode;
  removedConnectionId?: string;
  removedRequesterUserId?: string;
}

export interface ExchangeReportInput {
  reporterUserId: string;
  targetUserId: string;
  category: ExchangeReportCategory;
  context: string | null;
}

export interface ExchangeReportMutationResult {
  duplicate: boolean;
}

export interface ExchangeSafetyReadStore {
  isBlocked(firstUserId: string, secondUserId: string): Promise<boolean>;
  isBlockedBy(blockerUserId: string, blockedUserId: string): Promise<boolean>;
  isBlockedOnClient(
    client: PoolClient,
    firstUserId: string,
    secondUserId: string,
  ): Promise<boolean>;
}

export interface ExchangeSafetyRepository extends ExchangeSafetyReadStore {
  blockUser(blockerUserId: string, blockedUserId: string): Promise<ExchangeBlockMutationResult>;
  unblockUser(blockerUserId: string, blockedUserId: string): Promise<ExchangeBlockMutationResult>;
  submitReport(input: ExchangeReportInput): Promise<ExchangeReportMutationResult>;
}
