import { Inject, Injectable, Optional } from '@nestjs/common';
import { ReputationService } from '../reputation/reputation.service';
import {
  MEMBERSHIP_FULFILLMENT_REPOSITORY,
  type MembershipFulfillmentRepository,
} from './membership.fulfillment.repository';

export const CONTRIBUTION_CREDIT_CONTRACT_VERSION = 'membership-contribution-credit-v1' as const;
export const CONTRIBUTION_CREDIT_RULE_VERSION = 'membership-credit-v1' as const;
export const CONTRIBUTION_CREDIT_TYPE = 'MEMBERSHIP_ELIGIBILITY_CREDIT' as const;
export const REPUTATION_POINTS_PER_MEMBERSHIP_CREDIT = 10;

export class MembershipContributionCreditError extends Error {
  readonly name = 'MembershipContributionCreditError';

  constructor(
    readonly code: 'MEMBERSHIP_CREDIT_USER_INVALID' | 'MEMBERSHIP_CREDIT_TIME_INVALID',
    message: string,
  ) {
    super(message);
  }
}

export interface MembershipContributionCreditProjection {
  contractVersion: typeof CONTRIBUTION_CREDIT_CONTRACT_VERSION;
  type: typeof CONTRIBUTION_CREDIT_TYPE;
  ruleVersion: typeof CONTRIBUTION_CREDIT_RULE_VERSION;
  conversion: {
    sourceSystem: 'community_reputation';
    reputationPointsPerCredit: typeof REPUTATION_POINTS_PER_MEMBERSHIP_CREDIT;
  };
  eligibleReputationPoints: number;
  redeemedCreditUnits: number;
  availableCreditUnits: number;
  remainderReputationPoints: number;
  expirationPolicy: 'NONE_DERIVED_FROM_CURRENT_LEDGER';
  redemption: {
    mode: 'SERVER_AUTHORITATIVE_IDEMPOTENT';
    grantsMembership: true;
    actsAsPaymentTender: false;
    period: 'ONE_MONTH_PER_CREDIT_UNIT';
  };
  evaluatedAt: string;
}

/**
 * Contribution credit remains a non-monetary, server-derived projection.
 * Redemption records consume eligibility units without debiting or rewriting
 * the append-only Reputation ledger; the fulfillment boundary grants only the
 * explicit one-month-per-unit membership period.
 */
@Injectable()
export class MembershipContributionCreditService {
  constructor(
    private readonly reputation: ReputationService,
    @Optional()
    @Inject(MEMBERSHIP_FULFILLMENT_REPOSITORY)
    private readonly fulfillment?: MembershipFulfillmentRepository,
  ) {}

  async getProjection(
    userId: string,
    now = new Date(),
  ): Promise<MembershipContributionCreditProjection> {
    assertUserAndTime(userId, now);
    const balance = await this.reputation.getBalance(userId, 'community_reputation');
    const eligibleReputationPoints = Math.max(0, Math.trunc(balance));
    const derivedCreditUnits = Math.floor(
      eligibleReputationPoints / REPUTATION_POINTS_PER_MEMBERSHIP_CREDIT,
    );
    const redeemedCreditUnits = this.fulfillment
      ? await this.fulfillment.getRedeemedContributionCreditUnits(userId)
      : 0;
    const availableCreditUnits = Math.max(0, derivedCreditUnits - redeemedCreditUnits);

    return {
      contractVersion: CONTRIBUTION_CREDIT_CONTRACT_VERSION,
      type: CONTRIBUTION_CREDIT_TYPE,
      ruleVersion: CONTRIBUTION_CREDIT_RULE_VERSION,
      conversion: {
        sourceSystem: 'community_reputation',
        reputationPointsPerCredit: REPUTATION_POINTS_PER_MEMBERSHIP_CREDIT,
      },
      eligibleReputationPoints,
      redeemedCreditUnits,
      availableCreditUnits,
      remainderReputationPoints: eligibleReputationPoints % REPUTATION_POINTS_PER_MEMBERSHIP_CREDIT,
      expirationPolicy: 'NONE_DERIVED_FROM_CURRENT_LEDGER',
      redemption: {
        mode: 'SERVER_AUTHORITATIVE_IDEMPOTENT',
        grantsMembership: true,
        actsAsPaymentTender: false,
        period: 'ONE_MONTH_PER_CREDIT_UNIT',
      },
      evaluatedAt: now.toISOString(),
    };
  }
}

function assertUserAndTime(userId: string, now: Date): void {
  if (!isUuid(userId)) {
    throw new MembershipContributionCreditError(
      'MEMBERSHIP_CREDIT_USER_INVALID',
      'Membership credit user identity is invalid',
    );
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new MembershipContributionCreditError(
      'MEMBERSHIP_CREDIT_TIME_INVALID',
      'Membership credit evaluation time is invalid',
    );
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
