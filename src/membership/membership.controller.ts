import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenGuard, type AuthenticatedRequest } from '../auth/guards/access-token.guard';
import { success } from '../common/http/api-response';
import { MembershipContributionCreditService } from './membership.contribution-credit';
import { CreateMembershipOrderDto } from './membership.payment.dto';
import { MembershipPaymentService } from './membership.payment.service';
import { MembershipPolicyService } from './membership.policy';
import { MembershipAuthorizationService } from './membership.service';

@Controller('membership')
export class MembershipController {
  constructor(
    private readonly memberships: MembershipAuthorizationService,
    private readonly policy: MembershipPolicyService,
    private readonly contributionCredits: MembershipContributionCreditService,
    private readonly payments: MembershipPaymentService,
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

  @Post('orders')
  @UseGuards(AccessTokenGuard)
  async createOrder(
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: CreateMembershipOrderDto,
  ) {
    return success(
      await this.payments.createOrder(request.user!.user.id, idempotencyKey, input),
      'Membership payment order',
    );
  }

  @Get('orders/:orderId')
  @UseGuards(AccessTokenGuard)
  async getOrder(
    @Req() request: AuthenticatedRequest,
    @Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string,
  ) {
    return success(
      await this.payments.getOrder(request.user!.user.id, orderId),
      'Membership payment order',
    );
  }

  @Post('orders/:orderId/payment-attempts')
  @UseGuards(AccessTokenGuard)
  async createPaymentAttempt(
    @Req() request: AuthenticatedRequest,
    @Param('orderId', new ParseUUIDPipe({ version: '4' })) orderId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return success(
      await this.payments.createPaymentAttempt(request.user!.user.id, orderId, idempotencyKey),
      'Membership payment attempt',
    );
  }

  @Get('payment-attempts/:attemptId')
  @UseGuards(AccessTokenGuard)
  async getPaymentAttempt(
    @Req() request: AuthenticatedRequest,
    @Param('attemptId', new ParseUUIDPipe({ version: '4' })) attemptId: string,
  ) {
    return success(
      await this.payments.getAttempt(request.user!.user.id, attemptId),
      'Membership payment attempt',
    );
  }
}
