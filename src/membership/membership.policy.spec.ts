import { describe, expect, it } from '@jest/globals';
import { InMemoryMembershipRepository } from './membership.repository';
import { MembershipAuthorizationService } from './membership.service';
import {
  MembershipPolicyService,
  MEMBERSHIP_POLICY_VERSION,
} from './membership.policy';
import type {
  MembershipEntitlementDefinition,
  MembershipPlanVersion,
  MembershipSubscription,
} from './membership.types';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SUBSCRIPTION_ID = '22222222-2222-4222-8222-222222222222';
const COMMUNITY_V1_ID = '33333333-3333-4333-8333-333333333333';
const COMMUNITY_V2_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-09-30T12:00:00.000Z');

const communityV1: MembershipPlanVersion = {
  id: COMMUNITY_V1_ID,
  productCode: 'COMMUNITY_MEMBER',
  version: 1,
  status: 'ACTIVE',
  displayName: 'Community Member',
  description: 'Member plan version one',
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  activatedAt: new Date('2026-09-01T00:00:00.000Z'),
  retiredAt: null,
};

const communityV2: MembershipPlanVersion = {
  ...communityV1,
  id: COMMUNITY_V2_ID,
  version: 2,
  displayName: 'Community Member v2',
  createdAt: new Date('2026-09-20T00:00:00.000Z'),
  activatedAt: new Date('2026-09-20T00:00:00.000Z'),
};

function subscription(overrides: Partial<MembershipSubscription> = {}): MembershipSubscription {
  return {
    id: SUBSCRIPTION_ID,
    userId: USER_ID,
    planVersionId: COMMUNITY_V1_ID,
    status: 'ACTIVE',
    source: 'ADMIN_GRANT',
    startsAt: new Date('2026-09-01T00:00:00.000Z'),
    endsAt: new Date('2026-10-01T00:00:00.000Z'),
    cancelledAt: null,
    revokedAt: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

function entitlement(
  featureKey: string,
  overrides: Partial<MembershipEntitlementDefinition> = {},
): MembershipEntitlementDefinition {
  return {
    id: `${featureKey}-id`,
    planVersionId: COMMUNITY_V1_ID,
    featureKey,
    limit: null,
    limitUnit: null,
    parameters: {},
    ...overrides,
  };
}

function policy(seed: ConstructorParameters<typeof InMemoryMembershipRepository>[0] = {}): MembershipPolicyService {
  return new MembershipPolicyService(
    new MembershipAuthorizationService(new InMemoryMembershipRepository(seed)),
  );
}

function capability(projection: Awaited<ReturnType<MembershipPolicyService['getPolicyProjection']>>, featureKey: string) {
  return projection.capabilities.find((item) => item.featureKey === featureKey);
}

describe('MembershipPolicyService', () => {
  it('publishes a useful Free matrix and fails closed for unimplemented premium capabilities', async () => {
    const service = policy();

    const projection = await service.getPolicyProjection(USER_ID, NOW);

    expect(projection).toMatchObject({
      version: MEMBERSHIP_POLICY_VERSION,
      tier: 'FREE',
      plan: { productCode: 'FREE', version: 1 },
      membership: { status: 'DEFAULT_FREE' },
    });
    expect(capability(projection, 'community.public')).toMatchObject({ decision: 'GRANTED' });
    expect(capability(projection, 'library.public')).toMatchObject({ decision: 'GRANTED' });
    expect(capability(projection, 'exchange.basic')).toMatchObject({ decision: 'GRANTED' });
    expect(capability(projection, 'ai.practice')).toMatchObject({
      decision: 'GRANTED',
      limit: 20_000,
      limitUnit: 'tokens_per_day',
    });
    expect(capability(projection, 'practice.advanced')).toMatchObject({ decision: 'DENIED' });
    await expect(service.resolve({ userId: USER_ID, entitlementKey: 'ai.practice' })).resolves.toMatchObject({
      maxTokensPerWindow: 20_000,
      quotaWindowMs: 24 * 60 * 60 * 1_000,
      maxRequestsPerWindow: 20,
    });
    await expect(service.authorize(USER_ID, 'analytics.progress', NOW)).resolves.toMatchObject({
      allowed: false,
      reason: 'UNKNOWN_POLICY_FEATURE',
    });
  });

  it('uses active server entitlements for member-only capabilities and member AI quota', async () => {
    const service = policy({
      plans: [communityV1, communityV2],
      entitlements: [
        entitlement('practice.advanced'),
        entitlement('ai.practice', { limit: 100_000, limitUnit: 'tokens_per_day' }),
      ],
      subscriptions: [subscription()],
    });

    const projection = await service.getPolicyProjection(USER_ID, NOW);

    expect(projection.tier).toBe('MEMBER');
    await expect(service.authorize(USER_ID, 'practice.advanced', NOW)).resolves.toMatchObject({
      allowed: true,
      reason: 'MEMBER_ENTITLEMENT',
    });
    expect(capability(projection, 'ai.practice')).toMatchObject({
      decision: 'GRANTED',
      limit: 100_000,
      limitUnit: 'tokens_per_day',
    });
    expect(capability(projection, 'community.public')).toMatchObject({ decision: 'GRANTED' });
  });

  it('does not reinterpret a historical subscription with a newer plan version', async () => {
    const service = policy({
      plans: [communityV1, communityV2],
      entitlements: [
        entitlement('practice.advanced'),
        {
          ...entitlement('ai.practice'),
          id: 'v2-ai-practice-id',
          planVersionId: COMMUNITY_V2_ID,
          limit: 999_999,
        },
      ],
      subscriptions: [subscription()],
    });

    const decision = await service.authorize(USER_ID, 'ai.practice', NOW);

    expect(decision).toMatchObject({ allowed: true, limit: 20_000, limitUnit: 'tokens_per_day' });
  });

  it.each([
    ['expired', subscription({ endsAt: NOW })],
    ['future', subscription({ status: 'SCHEDULED', startsAt: new Date('2026-10-01T00:00:00.000Z') })],
    ['revoked', subscription({ status: 'REVOKED', revokedAt: new Date('2026-09-15T00:00:00.000Z') })],
  ])('falls back to Free for a %s membership', async (_label, memberSubscription) => {
    const service = policy({
      plans: [communityV1],
      entitlements: [entitlement('practice.advanced')],
      subscriptions: [memberSubscription],
    });

    const projection = await service.getPolicyProjection(USER_ID, NOW);

    expect(projection.tier).toBe('FREE');
    expect(capability(projection, 'ai.practice')).toMatchObject({ limit: 20_000 });
    expect(capability(projection, 'practice.advanced')).toMatchObject({ decision: 'DENIED' });
  });

  it('fails closed when a member entitlement is malformed instead of granting a larger quota', async () => {
    const service = policy({
      plans: [communityV1],
      entitlements: [entitlement('ai.practice', { limit: -1, limitUnit: 'tokens_per_day' })],
      subscriptions: [subscription()],
    });

    await expect(service.authorize(USER_ID, 'ai.practice', NOW)).resolves.toMatchObject({
      allowed: true,
      limit: 20_000,
      limitUnit: 'tokens_per_day',
      reason: 'FREE_BASELINE',
    });
  });
});
