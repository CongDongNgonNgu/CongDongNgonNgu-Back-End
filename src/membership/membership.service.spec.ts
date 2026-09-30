import { describe, expect, it } from '@jest/globals';
import { InMemoryMembershipRepository } from './membership.repository';
import {
  MembershipAuthorizationService,
  type MembershipAuthorizationServiceError,
} from './membership.service';
import type {
  MembershipEntitlementDefinition,
  MembershipPlanVersion,
  MembershipSubscription,
} from './membership.types';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SUBSCRIPTION_ID = '22222222-2222-4222-8222-222222222222';
const COMMUNITY_V1_ID = '33333333-3333-4333-8333-333333333333';
const COMMUNITY_V2_ID = '44444444-4444-4444-8444-444444444444';
const ENTITLEMENT_ID = '55555555-5555-4555-8555-555555555555';
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

const advancedPractice: MembershipEntitlementDefinition = {
  id: ENTITLEMENT_ID,
  planVersionId: COMMUNITY_V1_ID,
  featureKey: 'practice.advanced',
  limit: 20,
  limitUnit: 'per_month',
  parameters: { mode: 'guided' },
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

describe('MembershipAuthorizationService', () => {
  it('uses the server-defined Free fallback when no paid membership row exists', async () => {
    const service = new MembershipAuthorizationService(new InMemoryMembershipRepository());

    const projection = await service.getCapabilityProjection(USER_ID, NOW);
    const decision = await service.authorize(USER_ID, 'practice.advanced', NOW);

    expect(projection.plan).toMatchObject({ productCode: 'FREE', version: 1, status: 'ACTIVE' });
    expect(projection.membership).toMatchObject({ status: 'DEFAULT_FREE', source: 'DEFAULT_FREE' });
    expect(projection.entitlements).toEqual([]);
    expect(decision).toMatchObject({
      allowed: false,
      featureKey: 'practice.advanced',
      reason: 'UNKNOWN_FEATURE',
      planCode: 'FREE',
      planVersion: 1,
    });
  });

  it('authorizes an active subscription from its referenced plan version only', async () => {
    const service = new MembershipAuthorizationService(new InMemoryMembershipRepository({
      plans: [communityV1, communityV2],
      entitlements: [advancedPractice],
      subscriptions: [subscription()],
    }));

    const decision = await service.authorize(USER_ID, 'practice.advanced', NOW);
    const projection = await service.getCapabilityProjection(USER_ID, NOW);

    expect(decision).toMatchObject({
      allowed: true,
      limit: 20,
      limitUnit: 'per_month',
      parameters: { mode: 'guided' },
      planCode: 'COMMUNITY_MEMBER',
      planVersion: 1,
      reason: 'ENTITLED',
    });
    expect(projection.plan).toMatchObject({ productCode: 'COMMUNITY_MEMBER', version: 1 });
    expect(projection.entitlements).toEqual([
      expect.objectContaining({ featureKey: 'practice.advanced', decision: 'GRANTED', limit: 20 }),
    ]);
  });

  it('fails closed to Free when a membership is expired at the exact end boundary', async () => {
    const service = new MembershipAuthorizationService(new InMemoryMembershipRepository({
      plans: [communityV1],
      entitlements: [advancedPractice],
      subscriptions: [subscription({ endsAt: NOW })],
    }));

    const projection = await service.getCapabilityProjection(USER_ID, NOW);
    const decision = await service.authorize(USER_ID, 'practice.advanced', NOW);

    expect(projection.plan.productCode).toBe('FREE');
    expect(projection.membership.status).toBe('EXPIRED');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('UNKNOWN_FEATURE');
  });

  it('does not activate a scheduled subscription before startsAt', async () => {
    const service = new MembershipAuthorizationService(new InMemoryMembershipRepository({
      plans: [communityV1],
      entitlements: [advancedPractice],
      subscriptions: [subscription({
        status: 'SCHEDULED',
        startsAt: new Date('2026-10-01T00:00:00.000Z'),
      })],
    }));

    const projection = await service.getCapabilityProjection(USER_ID, NOW);

    expect(projection.plan.productCode).toBe('FREE');
    expect(projection.membership.status).toBe('SCHEDULED');
    expect(projection.entitlements).toEqual([]);
  });

  it('returns a denied decision instead of trusting an invalid or unknown client feature key', async () => {
    const service = new MembershipAuthorizationService(new InMemoryMembershipRepository());

    await expect(service.authorize(USER_ID, 'Practice Advanced', NOW)).resolves.toMatchObject({
      allowed: false,
      reason: 'INVALID_FEATURE_KEY',
    });
    await expect(service.authorize(USER_ID, 'premium.secret', NOW)).resolves.toMatchObject({
      allowed: false,
      reason: 'UNKNOWN_FEATURE',
    });
  });

  it('rejects malformed user identity without exposing repository details', async () => {
    const service = new MembershipAuthorizationService(new InMemoryMembershipRepository());

    await expect(service.getCapabilityProjection('not-a-uuid', NOW)).rejects.toMatchObject({
      code: 'MEMBERSHIP_USER_INVALID',
    } satisfies Partial<MembershipAuthorizationServiceError>);
  });
});
