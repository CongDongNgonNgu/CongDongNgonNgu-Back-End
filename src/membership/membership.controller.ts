import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, type AuthenticatedRequest } from '../auth/guards/access-token.guard';
import { success } from '../common/http/api-response';
import { MembershipAuthorizationService } from './membership.service';

@Controller('membership')
export class MembershipController {
  constructor(private readonly memberships: MembershipAuthorizationService) {}

  @Get('capabilities')
  @UseGuards(AccessTokenGuard)
  async capabilities(@Req() request: AuthenticatedRequest) {
    return success(
      await this.memberships.getCapabilityProjection(request.user!.user.id),
      'Membership capabilities',
    );
  }
}
