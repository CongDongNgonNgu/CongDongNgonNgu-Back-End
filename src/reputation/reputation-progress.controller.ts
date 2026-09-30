import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, type AuthenticatedRequest } from '../auth/guards/access-token.guard';
import { success } from '../common/http/api-response';
import {
  GamificationService,
  type ContributorProgress,
} from './gamification.service';

export interface CommunityReputationProgressResponse {
  communityReputation: number;
  contributorLevel: {
    id: ContributorProgress['contributorLevel']['id'];
    title: string;
    minReputation: number;
    nextLevel: {
      id: ContributorProgress['contributorLevel']['id'];
      title: string;
      minReputation: number;
    } | null;
  };
  badges: Array<{
    id: ContributorProgress['badges'][number]['id'];
    title: string;
    description: string;
    threshold: number;
    status: ContributorProgress['badges'][number]['status'];
    awardedAt: string | null;
    revokedAt: string | null;
  }>;
  activeContributionCount: number;
}

@Controller('reputation')
export class ReputationProgressController {
  constructor(private readonly gamification: GamificationService) {}

  @Get('progress')
  @UseGuards(AccessTokenGuard)
  async progress(@Req() request: AuthenticatedRequest) {
    const projection = await this.gamification.getContributorProgress(request.user!.user.id);
    return success(toCommunityReputationProgressResponse(projection), 'Community reputation progress');
  }
}

function toCommunityReputationProgressResponse(
  projection: ContributorProgress,
): CommunityReputationProgressResponse {
  return {
    communityReputation: projection.communityReputation,
    contributorLevel: {
      id: projection.contributorLevel.id,
      title: projection.contributorLevel.title,
      minReputation: projection.contributorLevel.minReputation,
      nextLevel: projection.contributorLevel.nextLevel
        ? {
            id: projection.contributorLevel.nextLevel.id,
            title: projection.contributorLevel.nextLevel.title,
            minReputation: projection.contributorLevel.nextLevel.minReputation,
          }
        : null,
    },
    badges: projection.badges.map((badge) => ({
      id: badge.id,
      title: badge.title,
      description: badge.description,
      threshold: badge.threshold,
      status: badge.status,
      awardedAt: badge.awardedAt,
      revokedAt: badge.revokedAt,
    })),
    activeContributionCount: projection.activeContributionCount,
  };
}
