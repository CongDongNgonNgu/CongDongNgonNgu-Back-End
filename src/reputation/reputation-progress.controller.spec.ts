import { describe, expect, it, jest } from '@jest/globals';
import { ReputationProgressController } from './reputation-progress.controller';
import type { ContributorProgress } from './gamification.service';

describe('ReputationProgressController', () => {
  it('returns a learner-safe projection without ledger internals', async () => {
    const projection: ContributorProgress = {
      communityReputation: 50,
      contributorLevel: {
        id: 'TRUSTED_CONTRIBUTOR',
        title: 'Trusted contributor',
        minReputation: 50,
        ruleVersion: 'community-gamification-v1',
        nextLevel: {
          id: 'COMMUNITY_STEWARD',
          title: 'Community steward',
          minReputation: 100,
        },
      },
      badges: [{
        id: 'CORRECTION_HELPER',
        title: 'Correction helper',
        description: 'One accepted public language correction.',
        sourceType: 'CORRECTION_ACCEPTED',
        threshold: 1,
        ruleVersion: 'community-gamification-v1',
        status: 'REVOKED',
        evidenceSourceIds: ['correction-1'],
        awardedAt: '2026-09-30T00:00:00.000Z',
        revokedAt: '2026-09-30T01:00:00.000Z',
      }],
      activeContributionCount: 2,
      ledgerSummary: {
        totalEntries: 3,
        reversedEntries: 1,
        ruleVersions: ['community-gamification-v1'],
      },
    };
    const gamification = {
      getContributorProgress: jest.fn<(userId: string) => Promise<ContributorProgress>>().mockResolvedValue(projection),
    };
    const controller = new ReputationProgressController(gamification as never);

    await expect(controller.progress({ user: { user: { id: 'user-1' } } } as never)).resolves.toEqual({
      success: true,
      message: 'Community reputation progress',
      data: {
        communityReputation: 50,
        contributorLevel: {
          id: 'TRUSTED_CONTRIBUTOR',
          title: 'Trusted contributor',
          minReputation: 50,
          nextLevel: {
            id: 'COMMUNITY_STEWARD',
            title: 'Community steward',
            minReputation: 100,
          },
        },
        badges: [{
          id: 'CORRECTION_HELPER',
          title: 'Correction helper',
          description: 'One accepted public language correction.',
          threshold: 1,
          status: 'REVOKED',
          awardedAt: '2026-09-30T00:00:00.000Z',
          revokedAt: '2026-09-30T01:00:00.000Z',
        }],
        activeContributionCount: 2,
      },
    });
    expect(gamification.getContributorProgress).toHaveBeenCalledWith('user-1');
  });
});
