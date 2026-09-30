import type { Pool } from 'pg';
import type {
  MembershipEntitlementDefinition,
  MembershipPlanVersion,
  MembershipSubscription,
} from './membership.types';
import {
  cloneDate,
  cloneParameters,
  isUuid,
} from './membership.types';

export const MEMBERSHIP_REPOSITORY = 'MEMBERSHIP_REPOSITORY';

export interface MembershipRepository {
  findPlanVersionById(id: string): Promise<MembershipPlanVersion | null>;
  listEntitlements(planVersionId: string): Promise<MembershipEntitlementDefinition[]>;
  findRelevantSubscription(userId: string, now: Date): Promise<MembershipSubscription | null>;
}

export interface InMemoryMembershipRepositorySeed {
  plans?: MembershipPlanVersion[];
  entitlements?: MembershipEntitlementDefinition[];
  subscriptions?: MembershipSubscription[];
}

export class InMemoryMembershipRepository implements MembershipRepository {
  private readonly plans: MembershipPlanVersion[];
  private readonly entitlements: MembershipEntitlementDefinition[];
  private readonly subscriptions: MembershipSubscription[];

  constructor(seed: InMemoryMembershipRepositorySeed = {}) {
    this.plans = (seed.plans ?? []).map(clonePlan);
    this.entitlements = (seed.entitlements ?? []).map(cloneEntitlement);
    this.subscriptions = (seed.subscriptions ?? []).map(cloneSubscription);
  }

  async findPlanVersionById(id: string): Promise<MembershipPlanVersion | null> {
    const plan = this.plans.find((candidate) => candidate.id === id);
    return plan ? clonePlan(plan) : null;
  }

  async listEntitlements(planVersionId: string): Promise<MembershipEntitlementDefinition[]> {
    return this.entitlements
      .filter((entitlement) => entitlement.planVersionId === planVersionId)
      .sort((left, right) => left.featureKey.localeCompare(right.featureKey))
      .map(cloneEntitlement);
  }

  async findRelevantSubscription(userId: string, now: Date): Promise<MembershipSubscription | null> {
    const candidates = this.subscriptions
      .filter((subscription) => subscription.userId === userId)
      .sort((left, right) => compareSubscriptionPriority(left, right, now));
    return candidates[0] ? cloneSubscription(candidates[0]) : null;
  }
}

export class PostgresMembershipRepository implements MembershipRepository {
  constructor(private readonly pool: Pool) {}

  async findPlanVersionById(id: string): Promise<MembershipPlanVersion | null> {
    if (!isUuid(id)) return null;
    const result = await this.pool.query(
      `SELECT mpv.id, mp.product_code, mpv.version, mpv.status,
              mpv.display_name, mpv.description, mpv.created_at,
              mpv.activated_at, mpv.retired_at
         FROM membership_plan_versions mpv
         JOIN membership_products mp ON mp.id = mpv.product_id
        WHERE mpv.id = $1::uuid
          AND mp.status = 'ACTIVE'::membership_product_status`,
      [id],
    );
    return result.rows[0] ? mapPlanRow(result.rows[0]) : null;
  }

  async listEntitlements(planVersionId: string): Promise<MembershipEntitlementDefinition[]> {
    if (!isUuid(planVersionId)) return [];
    const result = await this.pool.query(
      `SELECT id, product_version_id, feature_key, limit_value, limit_unit, parameters
         FROM membership_entitlement_definitions
        WHERE product_version_id = $1::uuid
        ORDER BY feature_key ASC, id ASC`,
      [planVersionId],
    );
    return result.rows.map(mapEntitlementRow);
  }

  async findRelevantSubscription(userId: string, now: Date): Promise<MembershipSubscription | null> {
    if (!isUuid(userId) || !Number.isFinite(now.getTime())) return null;
    const result = await this.pool.query(
      `SELECT id, user_id, product_version_id, status, source,
              starts_at, ends_at, cancelled_at, revoked_at, created_at, updated_at
         FROM membership_subscriptions
        WHERE user_id = $1::uuid
        ORDER BY CASE
          WHEN status = 'ACTIVE'::membership_subscription_status
            AND starts_at <= $2::timestamptz
            AND (ends_at IS NULL OR ends_at > $2::timestamptz) THEN 0
          WHEN status = 'SCHEDULED'::membership_subscription_status
            AND starts_at > $2::timestamptz THEN 1
          ELSE 2
        END,
        starts_at DESC,
        updated_at DESC,
        id DESC
        LIMIT 1`,
      [userId, now],
    );
    return result.rows[0] ? mapSubscriptionRow(result.rows[0]) : null;
  }
}

function compareSubscriptionPriority(
  left: MembershipSubscription,
  right: MembershipSubscription,
  now: Date,
): number {
  const rank = (subscription: MembershipSubscription): number => {
    if (
      subscription.status === 'ACTIVE' &&
      subscription.startsAt.getTime() <= now.getTime() &&
      (subscription.endsAt === null || subscription.endsAt.getTime() > now.getTime())
    ) return 0;
    if (subscription.status === 'SCHEDULED' && subscription.startsAt.getTime() > now.getTime()) return 1;
    return 2;
  };
  const byRank = rank(left) - rank(right);
  if (byRank !== 0) return byRank;
  const byStart = right.startsAt.getTime() - left.startsAt.getTime();
  if (byStart !== 0) return byStart;
  const byUpdated = right.updatedAt.getTime() - left.updatedAt.getTime();
  return byUpdated !== 0 ? byUpdated : right.id.localeCompare(left.id);
}

function clonePlan(value: MembershipPlanVersion): MembershipPlanVersion {
  return {
    ...value,
    createdAt: new Date(value.createdAt),
    activatedAt: cloneDate(value.activatedAt),
    retiredAt: cloneDate(value.retiredAt),
  };
}

function cloneEntitlement(value: MembershipEntitlementDefinition): MembershipEntitlementDefinition {
  return { ...value, parameters: cloneParameters(value.parameters) };
}

function cloneSubscription(value: MembershipSubscription): MembershipSubscription {
  return {
    ...value,
    startsAt: new Date(value.startsAt),
    endsAt: cloneDate(value.endsAt),
    cancelledAt: cloneDate(value.cancelledAt),
    revokedAt: cloneDate(value.revokedAt),
    createdAt: new Date(value.createdAt),
    updatedAt: new Date(value.updatedAt),
  };
}

function mapPlanRow(row: Record<string, unknown>): MembershipPlanVersion {
  return {
    id: String(row.id),
    productCode: String(row.product_code),
    version: Number(row.version),
    status: String(row.status) as MembershipPlanVersion['status'],
    displayName: String(row.display_name),
    description: String(row.description),
    createdAt: new Date(String(row.created_at)),
    activatedAt: row.activated_at ? new Date(String(row.activated_at)) : null,
    retiredAt: row.retired_at ? new Date(String(row.retired_at)) : null,
  };
}

function mapEntitlementRow(row: Record<string, unknown>): MembershipEntitlementDefinition {
  return {
    id: String(row.id),
    planVersionId: String(row.product_version_id),
    featureKey: String(row.feature_key),
    limit: row.limit_value === null || row.limit_value === undefined ? null : Number(row.limit_value),
    limitUnit: row.limit_unit ? String(row.limit_unit) : null,
    parameters: cloneParameters((row.parameters ?? {}) as Record<string, unknown>),
  };
}

function mapSubscriptionRow(row: Record<string, unknown>): MembershipSubscription {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    planVersionId: String(row.product_version_id),
    status: String(row.status) as MembershipSubscription['status'],
    source: String(row.source) as MembershipSubscription['source'],
    startsAt: new Date(String(row.starts_at)),
    endsAt: row.ends_at ? new Date(String(row.ends_at)) : null,
    cancelledAt: row.cancelled_at ? new Date(String(row.cancelled_at)) : null,
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at)) : null,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}
