import { Injectable } from '@nestjs/common';
import { ReputationService } from '../reputation/reputation.service';

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
  availableCreditUnits: number;
  remainderReputationPoints: number;
  expirationPolicy: 'NONE_DERIVED_FROM_CURRENT_LEDGER';
  redemption: {
    mode: 'PROJECTION_ONLY';
    grantsMembership: false;
    actsAsPaymentTender: false;
  };
  evaluatedAt: string;
}

/**
 * Contribution credit is a non-monetary, server-derived eligibility
 * projection. It does not debit Reputation, create a wallet, or grant a
 * membership period. A later lifecycle boundary must explicitly consume an
 * idempotent redemption fact before membership can be granted.
 */
@Injectable()
export class MembershipContributionCreditService {
  constructor(private readonly reputation: ReputationService) {}

  async getProjection(
    userId: string,
    now = new Date(),
  ): Promise<MembershipContributionCreditProjection> {
    assertUserAndTime(userId, now);
    const balance = await this.reputation.getBalance(userId, 'community_reputation');
    const eligibleReputationPoints = Math.max(0, Math.trunc(balance));
    const availableCreditUnits = Math.floor(
      eligibleReputationPoints / REPUTATION_POINTS_PER_MEMBERSHIP_CREDIT,
    );

    return {
      contractVersion: CONTRIBUTION_CREDIT_CONTRACT_VERSION,
      type: CONTRIBUTION_CREDIT_TYPE,
      ruleVersion: CONTRIBUTION_CREDIT_RULE_VERSION,
      conversion: {
        sourceSystem: 'community_reputation',
        reputationPointsPerCredit: REPUTATION_POINTS_PER_MEMBERSHIP_CREDIT,
      },
      eligibleReputationPoints,
      availableCreditUnits,
      remainderReputationPoints: eligibleReputationPoints % REPUTATION_POINTS_PER_MEMBERSHIP_CREDIT,
      expirationPolicy: 'NONE_DERIVED_FROM_CURRENT_LEDGER',
      redemption: {
        mode: 'PROJECTION_ONLY',
        grantsMembership: false,
        actsAsPaymentTender: false,
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
