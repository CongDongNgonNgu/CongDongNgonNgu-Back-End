import { Inject, Injectable } from '@nestjs/common';
import { ContributionRuleEngine } from './reputation.rules';
import type { ContributionRuleDecision, ContributionRuleInput } from './reputation.rules';
import {
  REPUTATION_LEDGER_REPOSITORY,
  type ReputationLedgerListQuery,
  type ReputationLedgerRepository,
  type ReputationLedgerAppendResult,
} from './reputation.repository';
import type { ReputationLedgerEntry, ReputationSystem } from './reputation.types';

export const REPUTATION_SERVICE = 'REPUTATION_SERVICE';

export interface ReputationContributionAwardResult {
  decision: ContributionRuleDecision;
  entry: ReputationLedgerEntry | null;
  created: boolean;
}

export interface ReverseReputationEntryInput {
  entryId: string;
  reason: string;
  idempotencyKey: string;
  createdAt: Date;
}

export class ReputationServiceError extends Error {
  readonly name = 'ReputationServiceError';

  constructor(
    readonly code: 'REPUTATION_ENTRY_NOT_FOUND' | 'REPUTATION_REVERSAL_TARGET_INVALID',
    message: string,
  ) {
    super(message);
  }
}

@Injectable()
export class ReputationService {
  constructor(
    @Inject(REPUTATION_LEDGER_REPOSITORY)
    private readonly repository: ReputationLedgerRepository,
    private readonly contributionRules: ContributionRuleEngine,
  ) {}

  async awardContribution(input: ContributionRuleInput): Promise<ReputationContributionAwardResult> {
    const decision = this.contributionRules.evaluate(input);
    if (!decision.eligible) return { decision, entry: null, created: false };

    const result = await this.repository.append({
      userId: input.contributorUserId,
      system: decision.system,
      sourceType: decision.sourceType,
      sourceId: decision.sourceId,
      delta: decision.delta,
      reason: decision.reason,
      ruleVersion: decision.ruleVersion,
      idempotencyKey: decision.idempotencyKey,
      reversalOfEntryId: null,
      createdAt: input.occurredAt,
    });
    return { decision, entry: result.entry, created: result.created };
  }

  async reverseEntry(input: ReverseReputationEntryInput): Promise<ReputationLedgerAppendResult> {
    const original = await this.repository.findById(input.entryId);
    if (!original) {
      throw new ReputationServiceError(
        'REPUTATION_ENTRY_NOT_FOUND',
        'The reputation ledger entry does not exist',
      );
    }
    if (original.reversalOfEntryId !== null || original.delta <= 0) {
      throw new ReputationServiceError(
        'REPUTATION_REVERSAL_TARGET_INVALID',
        'Only an unreversed positive award can be reversed',
      );
    }

    return this.repository.append({
      userId: original.userId,
      system: original.system,
      sourceType: original.sourceType,
      sourceId: original.sourceId,
      delta: -original.delta,
      reason: input.reason,
      ruleVersion: original.ruleVersion,
      idempotencyKey: input.idempotencyKey,
      reversalOfEntryId: original.id,
      createdAt: input.createdAt,
    });
  }

  getBalance(userId: string, system: ReputationSystem): Promise<number> {
    return this.repository.getBalance(userId, system);
  }

  listLedger(query: ReputationLedgerListQuery): Promise<ReputationLedgerEntry[]> {
    return this.repository.listByUser(query);
  }
}
