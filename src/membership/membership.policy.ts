import { Injectable } from '@nestjs/common';
import type { AiUsagePolicy, AiUsagePolicyResolver } from '../ai/ai.types';
import {
  DEFAULT_FREE_PRODUCT_CODE,
  type MembershipCapabilityProjection,
} from './membership.types';
import { MembershipAuthorizationService } from './membership.service';

export const MEMBERSHIP_POLICY_VERSION = 'membership-policy-v1' as const;
export const MEMBERSHIP_AI_FEATURE_KEY = 'ai.practice' as const;
export const FREE_AI_MAX_TOKENS_PER_DAY = 20_000;
export const FREE_AI_MAX_REQUESTS_PER_DAY = 20;
export const MEMBER_AI_MAX_REQUESTS_PER_DAY = 100;
export const AI_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1_000;

type PolicyDecision = 'GRANTED' | 'DENIED';
type MemberPolicyMode = 'INHERIT_FREE' | 'PLAN_ENTITLEMENT' | 'NOT_IMPLEMENTED';

interface FreePolicyValue {
  decision: PolicyDecision;
  limit: number | null;
  limitUnit: string | null;
}

export interface MembershipPolicyDefinition {
  featureKey: string;
  free: FreePolicyValue;
  member: MemberPolicyMode;
}

/**
 * Only capabilities backed by an implemented product boundary are listed.
 * Unknown keys, future rooms/events and unimplemented premium analytics are
 * intentionally absent and therefore fail closed.
 */
export const MEMBERSHIP_POLICY_MATRIX: readonly MembershipPolicyDefinition[] = Object.freeze([
  {
    featureKey: 'community.public',
    free: { decision: 'GRANTED', limit: null, limitUnit: null },
    member: 'INHERIT_FREE',
  },
  {
    featureKey: 'library.public',
    free: { decision: 'GRANTED', limit: null, limitUnit: null },
    member: 'INHERIT_FREE',
  },
  {
    featureKey: 'exchange.basic',
    free: { decision: 'GRANTED', limit: null, limitUnit: null },
    member: 'INHERIT_FREE',
  },
  {
    featureKey: MEMBERSHIP_AI_FEATURE_KEY,
    free: {
      decision: 'GRANTED',
      limit: FREE_AI_MAX_TOKENS_PER_DAY,
      limitUnit: 'tokens_per_day',
    },
    member: 'PLAN_ENTITLEMENT',
  },
  {
    featureKey: 'practice.advanced',
    free: { decision: 'DENIED', limit: null, limitUnit: null },
    member: 'PLAN_ENTITLEMENT',
  },
]);

export type MembershipPolicyTier = 'FREE' | 'MEMBER';

export type MembershipPolicyDecisionReason =
  | 'FREE_BASELINE'
  | 'MEMBER_ENTITLEMENT'
  | 'MEMBER_ENTITLEMENT_MISSING'
  | 'NOT_IMPLEMENTED'
  | 'UNKNOWN_POLICY_FEATURE';

export interface MembershipPolicyCapability {
  featureKey: string;
  decision: PolicyDecision;
  limit: number | null;
  limitUnit: string | null;
}

export interface MembershipPolicyProjection {
  version: typeof MEMBERSHIP_POLICY_VERSION;
  tier: MembershipPolicyTier;
  plan: {
    productCode: string;
    version: number;
    status: MembershipCapabilityProjection['plan']['status'];
  };
  membership: {
    status: MembershipCapabilityProjection['membership']['status'];
  };
  capabilities: MembershipPolicyCapability[];
  evaluatedAt: string;
}

export interface MembershipPolicyDecision {
  allowed: boolean;
  featureKey: string;
  limit: number | null;
  limitUnit: string | null;
  reason: MembershipPolicyDecisionReason;
  tier: MembershipPolicyTier;
  policyVersion: typeof MEMBERSHIP_POLICY_VERSION;
}

@Injectable()
export class MembershipPolicyService implements AiUsagePolicyResolver {
  constructor(private readonly memberships: MembershipAuthorizationService) {}

  async getPolicyProjection(
    userId: string,
    now = new Date(),
  ): Promise<MembershipPolicyProjection> {
    const membership = await this.memberships.getCapabilityProjection(userId, now);
    const tier = getPolicyTier(membership);

    return {
      version: MEMBERSHIP_POLICY_VERSION,
      tier,
      plan: { ...membership.plan },
      membership: { status: membership.membership.status },
      capabilities: MEMBERSHIP_POLICY_MATRIX.map((definition) => (
        this.resolveCapability(definition, tier, membership)
      )),
      evaluatedAt: now.toISOString(),
    };
  }

  async authorize(
    userId: string,
    featureKey: string,
    now = new Date(),
  ): Promise<MembershipPolicyDecision> {
    const projection = await this.getPolicyProjection(userId, now);
    const capability = projection.capabilities.find((item) => item.featureKey === featureKey);
    if (!capability) {
      return {
        allowed: false,
        featureKey,
        limit: null,
        limitUnit: null,
        reason: 'UNKNOWN_POLICY_FEATURE',
        tier: projection.tier,
        policyVersion: MEMBERSHIP_POLICY_VERSION,
      };
    }

    return {
      allowed: capability.decision === 'GRANTED',
      featureKey,
      limit: capability.limit,
      limitUnit: capability.limitUnit,
      reason: this.resolveReason(featureKey, capability, projection),
      tier: projection.tier,
      policyVersion: MEMBERSHIP_POLICY_VERSION,
    };
  }

  async resolve(input: { userId: string; entitlementKey?: string }): Promise<AiUsagePolicy | null> {
    const entitlementKey = input.entitlementKey?.trim() || MEMBERSHIP_AI_FEATURE_KEY;
    if (entitlementKey !== MEMBERSHIP_AI_FEATURE_KEY) return null;

    const decision = await this.authorize(input.userId, entitlementKey);
    if (
      !decision.allowed
      || decision.limit === null
      || decision.limitUnit !== 'tokens_per_day'
      || !Number.isSafeInteger(decision.limit)
      || decision.limit < 1
    ) {
      return null;
    }

    const scope = `${input.userId}:${entitlementKey}:${decision.policyVersion}`;
    return {
      quotaKey: `membership:ai:tokens:${scope}`,
      maxTokensPerWindow: decision.limit,
      quotaWindowMs: AI_QUOTA_WINDOW_MS,
      rateLimitKey: `membership:ai:requests:${scope}`,
      maxRequestsPerWindow: decision.tier === 'MEMBER'
        ? MEMBER_AI_MAX_REQUESTS_PER_DAY
        : FREE_AI_MAX_REQUESTS_PER_DAY,
      rateLimitWindowMs: AI_QUOTA_WINDOW_MS,
    };
  }

  private resolveCapability(
    definition: MembershipPolicyDefinition,
    tier: MembershipPolicyTier,
    membership: MembershipCapabilityProjection,
  ): MembershipPolicyCapability {
    if (tier === 'FREE' || definition.member === 'INHERIT_FREE') {
      return fromFreeDefinition(definition);
    }
    if (definition.member === 'NOT_IMPLEMENTED') {
      return denied(definition.featureKey);
    }

    const planEntitlement = membership.entitlements.find((item) => item.featureKey === definition.featureKey);
    if (!planEntitlement || planEntitlement.decision !== 'GRANTED') {
      return definition.free.decision === 'GRANTED'
        ? fromFreeDefinition(definition)
        : denied(definition.featureKey);
    }
    if (!isSafePlanEntitlement(definition.featureKey, planEntitlement.limit, planEntitlement.limitUnit)) {
      return definition.free.decision === 'GRANTED'
        ? fromFreeDefinition(definition)
        : denied(definition.featureKey);
    }

    return {
      featureKey: definition.featureKey,
      decision: 'GRANTED',
      limit: planEntitlement.limit,
      limitUnit: planEntitlement.limitUnit,
    };
  }

  private resolveReason(
    featureKey: string,
    capability: MembershipPolicyCapability,
    projection: MembershipPolicyProjection,
  ): MembershipPolicyDecisionReason {
    const definition = MEMBERSHIP_POLICY_MATRIX.find((item) => item.featureKey === featureKey);
    if (!definition) return 'UNKNOWN_POLICY_FEATURE';
    if (definition.member === 'NOT_IMPLEMENTED') return 'NOT_IMPLEMENTED';
    if (projection.tier === 'FREE' || definition.member === 'INHERIT_FREE') return 'FREE_BASELINE';
    if (capability.decision !== 'GRANTED') return 'MEMBER_ENTITLEMENT_MISSING';
    const isFreeEquivalent = definition.free.decision === 'GRANTED'
      && capability.limit === definition.free.limit
      && capability.limitUnit === definition.free.limitUnit;
    return isFreeEquivalent ? 'FREE_BASELINE' : 'MEMBER_ENTITLEMENT';
  }
}

function getPolicyTier(membership: MembershipCapabilityProjection): MembershipPolicyTier {
  return membership.membership.status === 'ACTIVE'
    && membership.plan.productCode !== DEFAULT_FREE_PRODUCT_CODE
    ? 'MEMBER'
    : 'FREE';
}

function fromFreeDefinition(definition: MembershipPolicyDefinition): MembershipPolicyCapability {
  return {
    featureKey: definition.featureKey,
    decision: definition.free.decision,
    limit: definition.free.limit,
    limitUnit: definition.free.limitUnit,
  };
}

function denied(featureKey: string): MembershipPolicyCapability {
  return { featureKey, decision: 'DENIED', limit: null, limitUnit: null };
}

function isSafePlanEntitlement(
  featureKey: string,
  limit: number | null,
  limitUnit: string | null,
): boolean {
  if (featureKey === MEMBERSHIP_AI_FEATURE_KEY) {
    return limit !== null && Number.isSafeInteger(limit) && limit > 0 && limitUnit === 'tokens_per_day';
  }
  return limit === null || (Number.isSafeInteger(limit) && limit >= 0 && typeof limitUnit === 'string');
}
