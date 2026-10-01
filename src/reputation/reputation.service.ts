import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  AntiFarmingRuleEngine,
  type AntiFarmingDecision,
} from './anti-farming.rules';
import { ContributionRuleEngine } from './reputation.rules';
import type { ContributionRuleDecision, ContributionRuleInput } from './reputation.rules';
import {
  REPUTATION_LEDGER_REPOSITORY,
  type ReputationLedgerListQuery,
  type ReputationLedgerRepository,
  type ReputationLedgerAppendResult,
} from './reputation.repository';
import type { ReputationLedgerEntry, ReputationSystem } from './reputation.types';
import {
  createNotificationDomainEvent,
  NOTIFICATION_DOMAIN_EVENT_SINK,
  type NotificationDomainEventSink,
} from '../notifications/notification-event-integration';
import { deriveContributorLevel } from './gamification.rules';

export const REPUTATION_SERVICE = 'REPUTATION_SERVICE';

export interface ReputationContributionAwardResult {
  decision: ContributionRuleDecision;
  antiFarming: AntiFarmingDecision;
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
    private readonly antiFarming: AntiFarmingRuleEngine = new AntiFarmingRuleEngine(),
    @Optional() @Inject(NOTIFICATION_DOMAIN_EVENT_SINK)
    private readonly notificationEvents?: NotificationDomainEventSink,
  ) {}

  async awardContribution(input: ContributionRuleInput): Promise<ReputationContributionAwardResult> {
    const decision = this.contributionRules.evaluate(input);
    const antiFarming = this.antiFarming.evaluate(input);
    if (!decision.eligible) return { decision, antiFarming, entry: null, created: false };
    if (!antiFarming.allowed) {
      return {
        decision: {
          eligible: false,
          code: antiFarming.code,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          ruleVersion: decision.ruleVersion,
          idempotencyKey: null,
        },
        antiFarming,
        entry: null,
        created: false,
      };
    }

    const previousBalance = this.notificationEvents
      ? await this.repository.getBalance(input.contributorUserId, 'community_reputation')
      : null;
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
    if (result.created && previousBalance !== null) {
      await this.publishMilestoneNotification(input, result.entry, previousBalance);
    }
    return { decision, antiFarming, entry: result.entry, created: result.created };
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

  private async publishMilestoneNotification(
    input: ContributionRuleInput,
    entry: ReputationLedgerEntry,
    previousBalance: number,
  ): Promise<void> {
    if (!this.notificationEvents || entry.delta <= 0) return;
    const currentBalance = await this.repository.getBalance(input.contributorUserId, 'community_reputation');
    const previousLevel = deriveContributorLevel(previousBalance);
    const currentLevel = deriveContributorLevel(currentBalance);
    if (previousLevel.id === currentLevel.id) return;
    await this.notificationEvents.publish(createNotificationDomainEvent({
      eventId: entry.id,
      eventType: 'reputation.milestone.achieved',
      aggregateType: 'REPUTATION_MILESTONE',
      aggregateId: entry.id,
      actor: input.actorUserId
        ? { kind: 'USER', userId: input.actorUserId }
        : { kind: 'SYSTEM', code: 'REPUTATION' },
      recipientUserId: input.contributorUserId,
      occurredAt: entry.createdAt,
      idempotencyKey: `reputation.milestone.achieved:${entry.id}:v1`,
      target: {
        kind: 'REPUTATION_MILESTONE',
        id: entry.id,
        path: '/profile',
      },
      variables: {
        level: currentLevel.id,
        milestone: currentLevel.title,
        reputation: currentLevel.minReputation,
      },
    }));
  }
}
