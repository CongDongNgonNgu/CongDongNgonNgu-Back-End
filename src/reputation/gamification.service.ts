import { Inject, Injectable } from '@nestjs/common';
import {
  REPUTATION_LEDGER_REPOSITORY,
  type ReputationLedgerRepository,
} from './reputation.repository';
import {
  deriveCommunityReputation,
  deriveContributorBadges,
  deriveContributorLevel,
  selectActiveCommunityContributionEntries,
  type ContributorBadgeProjection,
  type ContributorLevelProjection,
} from './gamification.rules';
import type { ReputationLedgerEntry } from './reputation.types';

const COMMUNITY_LEDGER_PAGE_SIZE = 100;
const MAX_PROGRESS_ENTRIES = 100_000;

export interface ContributorProgress {
  communityReputation: number;
  contributorLevel: ContributorLevelProjection;
  badges: ContributorBadgeProjection[];
  activeContributionCount: number;
  ledgerSummary: {
    totalEntries: number;
    reversedEntries: number;
    ruleVersions: string[];
  };
}

@Injectable()
export class GamificationService {
  constructor(
    @Inject(REPUTATION_LEDGER_REPOSITORY)
    private readonly repository: ReputationLedgerRepository,
  ) {}

  /**
   * Returns a learner-owned projection. Nothing in this projection is an
   * authorization role, moderation decision or mutable points balance.
   */
  async getContributorProgress(userId: string): Promise<ContributorProgress> {
    const entries = await this.listAllCommunityEntries(userId);
    const communityReputation = deriveCommunityReputation(entries);
    const persistedBalance = await this.repository.getBalance(userId, 'community_reputation');
    if (persistedBalance !== communityReputation) {
      throw new Error('REPUTATION_PROJECTION_NOT_RECONCILED');
    }

    return {
      communityReputation,
      contributorLevel: deriveContributorLevel(communityReputation),
      badges: deriveContributorBadges(entries),
      activeContributionCount: selectActiveCommunityContributionEntries(entries).length,
      ledgerSummary: {
        totalEntries: entries.length,
        reversedEntries: entries.filter((entry) => entry.reversalOfEntryId !== null).length,
        ruleVersions: [...new Set(entries.map((entry) => entry.ruleVersion))].sort(),
      },
    };
  }

  private async listAllCommunityEntries(userId: string): Promise<ReputationLedgerEntry[]> {
    const entries: ReputationLedgerEntry[] = [];
    let before: { createdAt: Date; id: string } | undefined;

    while (true) {
      const page = await this.repository.listByUser({
        userId,
        system: 'community_reputation',
        limit: COMMUNITY_LEDGER_PAGE_SIZE,
        before,
      });
      entries.push(...page);
      if (entries.length > MAX_PROGRESS_ENTRIES) {
        throw new Error('REPUTATION_PROGRESS_TOO_LARGE');
      }
      if (page.length < COMMUNITY_LEDGER_PAGE_SIZE) return entries;

      const last = page[page.length - 1];
      before = { createdAt: last.createdAt, id: last.id };
    }
  }
}
