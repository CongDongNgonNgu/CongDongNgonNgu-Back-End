export const MEMBERSHIP_PRODUCT_STATUSES = ['ACTIVE', 'RETIRED'] as const;
export type MembershipProductStatus = typeof MEMBERSHIP_PRODUCT_STATUSES[number];

export const MEMBERSHIP_PLAN_VERSION_STATUSES = ['DRAFT', 'ACTIVE', 'RETIRED'] as const;
export type MembershipPlanVersionStatus = typeof MEMBERSHIP_PLAN_VERSION_STATUSES[number];

export const MEMBERSHIP_SUBSCRIPTION_STATUSES = [
  'SCHEDULED',
  'ACTIVE',
  'EXPIRED',
  'CANCELLED',
  'REVOKED',
] as const;
export type MembershipSubscriptionStatus = typeof MEMBERSHIP_SUBSCRIPTION_STATUSES[number];

export const MEMBERSHIP_SUBSCRIPTION_SOURCES = [
  'DEFAULT_FREE',
  'ADMIN_GRANT',
  'CONTRIBUTION_CREDIT',
  'PURCHASE',
] as const;
export type MembershipSubscriptionSource = typeof MEMBERSHIP_SUBSCRIPTION_SOURCES[number];

export const DEFAULT_FREE_PRODUCT_CODE = 'FREE' as const;
export const DEFAULT_FREE_PLAN_VERSION = 1 as const;

export interface MembershipProduct {
  id: string;
  productCode: string;
  displayName: string;
  status: MembershipProductStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface MembershipPlanVersion {
  id: string;
  productCode: string;
  version: number;
  status: MembershipPlanVersionStatus;
  displayName: string;
  description: string;
  createdAt: Date;
  activatedAt: Date | null;
  retiredAt: Date | null;
}

export interface MembershipEntitlementDefinition {
  id: string;
  planVersionId: string;
  featureKey: string;
  limit: number | null;
  limitUnit: string | null;
  parameters: Record<string, unknown>;
}

export interface MembershipSubscription {
  id: string;
  userId: string;
  planVersionId: string;
  status: MembershipSubscriptionStatus;
  source: MembershipSubscriptionSource;
  startsAt: Date;
  endsAt: Date | null;
  cancelledAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type MembershipProjectionStatus = 'DEFAULT_FREE' | MembershipSubscriptionStatus;
export type MembershipCapabilityDecision = 'GRANTED' | 'DENIED';
export type MembershipAccessReason = 'ENTITLED' | 'UNKNOWN_FEATURE' | 'INVALID_FEATURE_KEY';

export interface MembershipCapability {
  featureKey: string;
  decision: MembershipCapabilityDecision;
  limit: number | null;
  limitUnit: string | null;
  parameters: Record<string, unknown>;
}

export interface MembershipCapabilityProjection {
  plan: {
    productCode: string;
    version: number;
    status: MembershipPlanVersionStatus;
  };
  membership: {
    status: MembershipProjectionStatus;
    source: MembershipSubscriptionSource;
    startsAt: string | null;
    endsAt: string | null;
  };
  entitlements: MembershipCapability[];
  evaluatedAt: string;
}

export interface MembershipAuthorizationDecision {
  allowed: boolean;
  featureKey: string;
  limit: number | null;
  limitUnit: string | null;
  parameters: Record<string, unknown>;
  planCode: string;
  planVersion: number;
  reason: MembershipAccessReason;
}

export function isValidMembershipFeatureKey(value: string): boolean {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,119}$/u.test(value);
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

export function cloneDate(value: Date | null): Date | null {
  return value ? new Date(value) : null;
}

export function cloneParameters(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
