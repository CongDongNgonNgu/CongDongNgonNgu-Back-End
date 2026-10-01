import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, type AuthenticatedRequest } from '../auth/guards/access-token.guard';
import { success } from '../common/http/api-response';
import { MembershipContributionCreditService } from './membership.contribution-credit';
import { MembershipPolicyService } from './membership.policy';
import { MembershipAuthorizationService } from './membership.service';

@Controller('membership')
export class MembershipController {
  constructor(
    private readonly memberships: MembershipAuthorizationService,
    private readonly policy: MembershipPolicyService,
    private readonly contributionCredits: MembershipContributionCreditService,
  ) {}

  @Get('capabilities')
  @UseGuards(AccessTokenGuard)
  async capabilities(@Req() request: AuthenticatedRequest) {
    return success(
      await this.memberships.getCapabilityProjection(request.user!.user.id),
      'Membership capabilities',
    );
  }

  @Get('policy')
  @UseGuards(AccessTokenGuard)
  async policyProjection(@Req() request: AuthenticatedRequest) {
    return success(
      await this.policy.getPolicyProjection(request.user!.user.id),
      'Membership policy',
    );
  }

  @Get('contribution-credit')
  @UseGuards(AccessTokenGuard)
  async contributionCredit(@Req() request: AuthenticatedRequest) {
    return success(
      await this.contributionCredits.getProjection(request.user!.user.id),
      'Contribution membership credit',
    );
  }
}
