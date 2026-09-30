import { Injectable } from '@nestjs/common';
import {
  DEFAULT_FREE_PLAN_VERSION,
  DEFAULT_FREE_PRODUCT_CODE,
  isValidMembershipFeatureKey,
  isUuid,
  type MembershipAuthorizationDecision,
  type MembershipCapability,
  type MembershipCapabilityProjection,
  type MembershipPlanVersion,
  type MembershipProjectionStatus,
  type MembershipSubscription,
} from './membership.types';
import { MEMBERSHIP_REPOSITORY, type MembershipRepository } from './membership.repository';
import { Inject } from '@nestjs/common';

const DEFAULT_FREE_PLAN_ID = '00000000-0000-4000-8000-000000000000';
const DEFAULT_FREE_DATE = new Date('1970-01-01T00:00:00.000Z');

export type MembershipAuthorizationServiceErrorCode =
  | 'MEMBERSHIP_USER_INVALID'
  | 'MEMBERSHIP_TIME_INVALID';

export class MembershipAuthorizationServiceError extends Error {
  readonly name = 'MembershipAuthorizationServiceError';

  constructor(
    readonly code: MembershipAuthorizationServiceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

@Injectable()
export class MembershipAuthorizationService {
  constructor(@Inject(MEMBERSHIP_REPOSITORY) private readonly repository: MembershipRepository) {}

  async authorize(
    userId: string,
    featureKey: string,
    now = new Date(),
  ): Promise<MembershipAuthorizationDecision> {
    if (!isValidMembershipFeatureKey(featureKey)) {
      const projection = await this.getCapabilityProjection(userId, now);
      return deniedDecision(featureKey, projection, 'INVALID_FEATURE_KEY');
    }

    const projection = await this.getCapabilityProjection(userId, now);
    const capability = projection.entitlements.find((item) => item.featureKey === featureKey);
    if (!capability) return deniedDecision(featureKey, projection, 'UNKNOWN_FEATURE');
    return {
      allowed: capability.decision === 'GRANTED',
      featureKey,
      limit: capability.limit,
      limitUnit: capability.limitUnit,
      parameters: cloneRecord(capability.parameters),
      planCode: projection.plan.productCode,
      planVersion: projection.plan.version,
      reason: 'ENTITLED',
    };
  }

  async getCapabilityProjection(userId: string, now = new Date()): Promise<MembershipCapabilityProjection> {
    assertUserAndTime(userId, now);
    const subscription = await this.repository.findRelevantSubscription(userId, now);
    const resolved = await this.resolvePlan(subscription, now);
    const entitlements = resolved.plan.status === 'ACTIVE' && resolved.subscriptionIsActive
      ? await this.repository.listEntitlements(resolved.plan.id)
      : [];

    return {
      plan: {
        productCode: resolved.plan.productCode,
        version: resolved.plan.version,
        status: resolved.plan.status,
      },
      membership: {
        status: resolved.membershipStatus,
        source: resolved.source,
        startsAt: subscription?.startsAt.toISOString() ?? null,
        endsAt: subscription?.endsAt?.toISOString() ?? null,
      },
      entitlements: entitlements
        .sort((left, right) => left.featureKey.localeCompare(right.featureKey))
        .map(toCapability),
      evaluatedAt: now.toISOString(),
    };
  }

  private async resolvePlan(
    subscription: MembershipSubscription | null,
    now: Date,
  ): Promise<{
    plan: MembershipPlanVersion;
    membershipStatus: MembershipProjectionStatus;
    source: MembershipSubscription['source'];
    subscriptionIsActive: boolean;
  }> {
    if (!subscription) {
      return {
        plan: defaultFreePlan(),
        membershipStatus: 'DEFAULT_FREE',
        source: 'DEFAULT_FREE',
        subscriptionIsActive: false,
      };
    }

    const membershipStatus = deriveMembershipStatus(subscription, now);
    if (membershipStatus !== 'ACTIVE') {
      return {
        plan: defaultFreePlan(),
        membershipStatus,
        source: subscription.source,
        subscriptionIsActive: false,
      };
    }

    const plan = await this.repository.findPlanVersionById(subscription.planVersionId);
    if (!plan || plan.status !== 'ACTIVE') {
      return {
        plan: defaultFreePlan(),
        membershipStatus,
        source: subscription.source,
        subscriptionIsActive: false,
      };
    }
    return {
      plan,
      membershipStatus,
      source: subscription.source,
      subscriptionIsActive: true,
    };
  }
}

function deriveMembershipStatus(
  subscription: MembershipSubscription,
  now: Date,
): MembershipProjectionStatus {
  if (subscription.status === 'ACTIVE') {
    if (subscription.startsAt.getTime() > now.getTime()) return 'SCHEDULED';
    if (subscription.endsAt && subscription.endsAt.getTime() <= now.getTime()) return 'EXPIRED';
  }
  return subscription.status;
}

function defaultFreePlan(): MembershipPlanVersion {
  return {
    id: DEFAULT_FREE_PLAN_ID,
    productCode: DEFAULT_FREE_PRODUCT_CODE,
    version: DEFAULT_FREE_PLAN_VERSION,
    status: 'ACTIVE',
    displayName: 'Free',
    description: 'The default Free plan.',
    createdAt: new Date(DEFAULT_FREE_DATE),
    activatedAt: new Date(DEFAULT_FREE_DATE),
    retiredAt: null,
  };
}

function deniedDecision(
  featureKey: string,
  projection: MembershipCapabilityProjection,
  reason: 'UNKNOWN_FEATURE' | 'INVALID_FEATURE_KEY',
): MembershipAuthorizationDecision {
  return {
    allowed: false,
    featureKey,
    limit: null,
    limitUnit: null,
    parameters: {},
    planCode: projection.plan.productCode,
    planVersion: projection.plan.version,
    reason,
  };
}

function toCapability(input: {
  featureKey: string;
  limit: number | null;
  limitUnit: string | null;
  parameters: Record<string, unknown>;
}): MembershipCapability {
  return {
    featureKey: input.featureKey,
    decision: 'GRANTED',
    limit: input.limit,
    limitUnit: input.limitUnit,
    parameters: cloneRecord(input.parameters),
  };
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function assertUserAndTime(userId: string, now: Date): void {
  if (!isUuid(userId)) {
    throw new MembershipAuthorizationServiceError(
      'MEMBERSHIP_USER_INVALID',
      'Membership user identity is invalid',
    );
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new MembershipAuthorizationServiceError(
      'MEMBERSHIP_TIME_INVALID',
      'Membership evaluation time is invalid',
    );
  }
}
