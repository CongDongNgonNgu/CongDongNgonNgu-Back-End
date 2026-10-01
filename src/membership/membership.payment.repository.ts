import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  cloneCheckoutOrder,
  clonePaymentAttempt,
  clonePaymentCatalogEntry,
  isSafeMinorAmount,
  isValidPaymentIdentifier,
  MAX_SAFE_MINOR_UNITS,
  type MembershipCheckoutOrder,
  type MembershipPaymentAttempt,
  type MembershipPaymentCatalogEntry,
  type MembershipPaymentCurrency,
  type MembershipPaymentAttemptStatus,
  type MembershipOrderStatus,
  type MembershipPlanPrice,
  type MembershipPricePeriodUnit,
} from './membership.payment.types';

export type { MembershipPaymentCatalogEntry } from './membership.payment.types';

export const MEMBERSHIP_PAYMENT_REPOSITORY = 'MEMBERSHIP_PAYMENT_REPOSITORY';

export interface CreateMembershipOrderInput {
  userId: string;
  planVersionId: string;
  priceId: string;
  idempotencyKeyHash: string;
  requestHash: string;
  now: Date;
}

export interface CreateMembershipAttemptInput {
  userId: string;
  orderId: string;
  providerCode: string;
  localAttemptReference: string;
  idempotencyKeyHash: string;
  requestHash: string;
  expiresAt: Date;
  now: Date;
}

export interface CreateMembershipOrderResult {
  order: MembershipCheckoutOrder;
  created: boolean;
}

export interface CreateMembershipAttemptResult {
  attempt: MembershipPaymentAttempt;
  shouldCallProvider: boolean;
}

export interface MembershipPaymentRepository {
  findPurchasableCatalogEntry(
    planVersionId: string,
    priceId: string,
    now: Date,
  ): Promise<MembershipPaymentCatalogEntry | null>;
  findOrderByIdempotency(userId: string, idempotencyKeyHash: string): Promise<MembershipCheckoutOrder | null>;
  createOrder(input: CreateMembershipOrderInput): Promise<CreateMembershipOrderResult>;
  findOwnedOrder(userId: string, orderId: string): Promise<MembershipCheckoutOrder | null>;
  findLatestAttemptForOrder(userId: string, orderId: string): Promise<MembershipPaymentAttempt | null>;
  createAttempt(input: CreateMembershipAttemptInput): Promise<CreateMembershipAttemptResult | null>;
  attachProviderCheckout(input: {
    userId: string;
    attemptId: string;
    providerReference: string;
    checkoutUrl: string;
    now: Date;
  }): Promise<MembershipPaymentAttempt | null>;
  markAttemptFailed(input: {
    userId: string;
    attemptId: string;
    failureCode: string;
    now: Date;
  }): Promise<MembershipPaymentAttempt | null>;
  findOwnedAttempt(userId: string, attemptId: string): Promise<MembershipPaymentAttempt | null>;
}

export type MembershipPaymentRepositoryErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'PRODUCT_UNAVAILABLE'
  | 'ORDER_NOT_PAYABLE'
  | 'REFERENCE_INVALID';

export class MembershipPaymentRepositoryError extends Error {
  readonly name = 'MembershipPaymentRepositoryError';

  constructor(
    readonly code: MembershipPaymentRepositoryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface InMemoryMembershipPaymentRepositorySeed {
  catalog?: MembershipPaymentCatalogEntry[];
}

export class InMemoryMembershipPaymentRepository implements MembershipPaymentRepository {
  private readonly catalog: MembershipPaymentCatalogEntry[];
  private readonly orders = new Map<string, MembershipCheckoutOrder>();
  private readonly attempts = new Map<string, MembershipPaymentAttempt>();
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(seed: InMemoryMembershipPaymentRepositorySeed = {}) {
    this.catalog = (seed.catalog ?? []).map(clonePaymentCatalogEntry);
  }

  async findPurchasableCatalogEntry(
    planVersionId: string,
    priceId: string,
    now: Date,
  ): Promise<MembershipPaymentCatalogEntry | null> {
    const value = this.catalog.find((entry) => (
      entry.planVersionId === planVersionId &&
      entry.price.id === priceId &&
      isCatalogEntryPurchasable(entry, now)
    ));
    return value ? clonePaymentCatalogEntry(value) : null;
  }

  async findOrderByIdempotency(userId: string, idempotencyKeyHash: string): Promise<MembershipCheckoutOrder | null> {
    const order = [...this.orders.values()].find((candidate) => (
      candidate.userId === userId && candidate.idempotencyKeyHash === idempotencyKeyHash
    ));
    return order ? cloneCheckoutOrder(order) : null;
  }

  createOrder(input: CreateMembershipOrderInput): Promise<CreateMembershipOrderResult> {
    return this.withMutation(async () => {
      const existing = [...this.orders.values()].find((order) => (
        order.userId === input.userId && order.idempotencyKeyHash === input.idempotencyKeyHash
      ));
      if (existing) {
        assertRequestReplay(existing.requestHash, input.requestHash);
        return { order: cloneCheckoutOrder(existing), created: false };
      }
      const catalog = await this.findPurchasableCatalogEntry(input.planVersionId, input.priceId, input.now);
      if (!catalog) throw productUnavailable();
      const order: MembershipCheckoutOrder = {
        id: randomUUID(),
        userId: input.userId,
        planVersionId: catalog.planVersionId,
        priceId: catalog.price.id,
        productCode: catalog.productCode,
        planVersion: catalog.planVersion,
        planDisplayName: catalog.planDisplayName,
        priceCode: catalog.price.code,
        amountMinor: catalog.price.amountMinor,
        currency: catalog.price.currency,
        periodUnit: catalog.price.periodUnit,
        periodCount: catalog.price.periodCount,
        status: 'PENDING_PAYMENT',
        idempotencyKeyHash: input.idempotencyKeyHash,
        requestHash: input.requestHash,
        createdAt: new Date(input.now),
        updatedAt: new Date(input.now),
      };
      this.orders.set(order.id, order);
      return { order: cloneCheckoutOrder(order), created: true };
    });
  }

  async findOwnedOrder(userId: string, orderId: string): Promise<MembershipCheckoutOrder | null> {
    const order = this.orders.get(orderId);
    return order?.userId === userId ? cloneCheckoutOrder(order) : null;
  }

  async findLatestAttemptForOrder(userId: string, orderId: string): Promise<MembershipPaymentAttempt | null> {
    const order = await this.findOwnedOrder(userId, orderId);
    if (!order) return null;
    const attempts = [...this.attempts.values()]
      .filter((attempt) => attempt.orderId === orderId)
      .sort(compareNewest);
    return attempts[0] ? clonePaymentAttempt(attempts[0]) : null;
  }

  createAttempt(input: CreateMembershipAttemptInput): Promise<CreateMembershipAttemptResult | null> {
    return this.withMutation(async () => {
      const existing = [...this.attempts.values()].find((attempt) => (
        attempt.userId === input.userId && attempt.idempotencyKeyHash === input.idempotencyKeyHash
      ));
      if (existing) {
        assertRequestReplay(existing.requestHash, input.requestHash);
        return { attempt: clonePaymentAttempt(existing), shouldCallProvider: false };
      }
      const order = await this.findOwnedOrder(input.userId, input.orderId);
      if (!order) return null;
      if (order.status !== 'PENDING_PAYMENT' || !isSafeMinorAmount(order.amountMinor)) {
        throw orderNotPayable();
      }
      for (const attempt of this.attempts.values()) {
        if (attempt.orderId !== order.id) continue;
        if (
          (attempt.status === 'CREATED' || attempt.status === 'PENDING') &&
          attempt.expiresAt.getTime() <= input.now.getTime()
        ) {
          attempt.status = 'EXPIRED';
          attempt.updatedAt = new Date(input.now);
        }
      }
      const open = [...this.attempts.values()]
        .filter((attempt) => attempt.orderId === order.id && isOpenAttempt(attempt, input.now))
        .sort(compareNewest)[0];
      if (open) return { attempt: clonePaymentAttempt(open), shouldCallProvider: false };

      const attempt: MembershipPaymentAttempt = {
        id: randomUUID(),
        userId: input.userId,
        orderId: order.id,
        providerCode: input.providerCode,
        localAttemptReference: input.localAttemptReference,
        providerReference: null,
        checkoutUrl: null,
        amountMinor: order.amountMinor,
        currency: order.currency,
        status: 'CREATED',
        idempotencyKeyHash: input.idempotencyKeyHash,
        requestHash: input.requestHash,
        expiresAt: new Date(input.expiresAt),
        failureCode: null,
        createdAt: new Date(input.now),
        updatedAt: new Date(input.now),
      };
      this.attempts.set(attempt.id, attempt);
      return { attempt: clonePaymentAttempt(attempt), shouldCallProvider: true };
    });
  }

  attachProviderCheckout(input: {
    userId: string;
    attemptId: string;
    providerReference: string;
    checkoutUrl: string;
    now: Date;
  }): Promise<MembershipPaymentAttempt | null> {
    return this.withMutation(async () => {
      const attempt = this.attempts.get(input.attemptId);
      if (!attempt || attempt.userId !== input.userId) return null;
      if (attempt.status === 'CREATED') {
        const duplicate = [...this.attempts.values()].find((candidate) => (
          candidate.id !== attempt.id &&
          candidate.providerCode === attempt.providerCode &&
          candidate.providerReference === input.providerReference
        ));
        if (duplicate) throw new MembershipPaymentRepositoryError(
          'REFERENCE_INVALID',
          'Payment provider reference is already mapped',
        );
        attempt.providerReference = input.providerReference;
        attempt.checkoutUrl = input.checkoutUrl;
        attempt.status = 'PENDING';
        attempt.updatedAt = new Date(input.now);
      }
      return clonePaymentAttempt(attempt);
    });
  }

  markAttemptFailed(input: {
    userId: string;
    attemptId: string;
    failureCode: string;
    now: Date;
  }): Promise<MembershipPaymentAttempt | null> {
    return this.withMutation(async () => {
      const attempt = this.attempts.get(input.attemptId);
      if (!attempt || attempt.userId !== input.userId) return null;
      if (attempt.status === 'CREATED') {
        attempt.status = 'FAILED';
        attempt.failureCode = input.failureCode;
        attempt.updatedAt = new Date(input.now);
      }
      return clonePaymentAttempt(attempt);
    });
  }

  async findOwnedAttempt(userId: string, attemptId: string): Promise<MembershipPaymentAttempt | null> {
    const attempt = this.attempts.get(attemptId);
    return attempt?.userId === userId ? clonePaymentAttempt(attempt) : null;
  }

  snapshot(): {
    catalog: MembershipPaymentCatalogEntry[];
    orders: MembershipCheckoutOrder[];
    attempts: MembershipPaymentAttempt[];
    subscriptions: never[];
  } {
    return {
      catalog: this.catalog.map(clonePaymentCatalogEntry),
      orders: [...this.orders.values()].map(cloneCheckoutOrder),
      attempts: [...this.attempts.values()].map(clonePaymentAttempt),
      subscriptions: [],
    };
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class PostgresMembershipPaymentRepository implements MembershipPaymentRepository {
  constructor(private readonly pool: Pool) {}

  async findPurchasableCatalogEntry(
    planVersionId: string,
    priceId: string,
    now: Date,
  ): Promise<MembershipPaymentCatalogEntry | null> {
    if (!isValidPaymentIdentifier(planVersionId) || !isValidPaymentIdentifier(priceId)) return null;
    const result = await this.pool.query(
      `SELECT mpv.id AS plan_version_id,
              mp.product_code,
              mp.status AS product_status,
              mpv.version AS plan_version,
              mpv.status AS plan_status,
              mpv.display_name AS plan_display_name,
              mpp.id AS price_id,
              mpp.price_code,
              mpp.status AS price_status,
              mpp.amount_minor,
              mpp.currency,
              mpp.period_unit,
              mpp.period_count,
              mpp.available_from,
              mpp.available_until,
              mpp.created_at AS price_created_at
         FROM membership_plan_prices mpp
         JOIN membership_plan_versions mpv ON mpv.id = mpp.plan_version_id
         JOIN membership_products mp ON mp.id = mpv.product_id
        WHERE mpv.id = $1::uuid
          AND mpp.id = $2::uuid
          AND mp.status = 'ACTIVE'::membership_product_status
          AND mpv.status = 'ACTIVE'::membership_plan_version_status
          AND mpp.status = 'ACTIVE'::membership_price_status
          AND mpp.available_from <= $3::timestamptz
          AND (mpp.available_until IS NULL OR mpp.available_until > $3::timestamptz)`,
      [planVersionId, priceId, now],
    );
    return result.rows[0] ? mapCatalogRow(result.rows[0]) : null;
  }

  async createOrder(input: CreateMembershipOrderInput): Promise<CreateMembershipOrderResult> {
    assertIdentifiers(input.userId, input.planVersionId, input.priceId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT id, user_id, plan_version_id, price_id, product_code,
                plan_version, plan_display_name, price_code, amount_minor,
                currency, period_unit, period_count, status,
                idempotency_key_hash, request_hash, created_at, updated_at
           FROM membership_checkout_orders
          WHERE user_id = $1::uuid AND idempotency_key_hash = $2
          FOR UPDATE`,
        [input.userId, input.idempotencyKeyHash],
      );
      if (existing.rows[0]) {
        const order = mapOrderRow(existing.rows[0]);
        assertRequestReplay(order.requestHash, input.requestHash);
        await client.query('COMMIT');
        return { order, created: false };
      }

      const catalog = await queryCatalog(client, input.planVersionId, input.priceId, input.now);
      if (!catalog) {
        await client.query('COMMIT');
        throw productUnavailable();
      }
      const inserted = await client.query(
        `INSERT INTO membership_checkout_orders (
           user_id, plan_version_id, price_id, product_code, plan_version,
           plan_display_name, price_code, amount_minor, currency, period_unit,
           period_count, status, idempotency_key_hash, request_hash,
           created_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::bigint,
           $9::membership_payment_currency, $10::membership_price_period_unit,
           $11, 'PENDING_PAYMENT'::membership_order_status, $12, $13, $14, $14
         )
         ON CONFLICT (user_id, idempotency_key_hash) DO NOTHING
         RETURNING id, user_id, plan_version_id, price_id, product_code,
                   plan_version, plan_display_name, price_code, amount_minor,
                   currency, period_unit, period_count, status,
                   idempotency_key_hash, request_hash, created_at, updated_at`,
        [
          input.userId,
          catalog.planVersionId,
          catalog.price.id,
          catalog.productCode,
          catalog.planVersion,
          catalog.planDisplayName,
          catalog.price.code,
          catalog.price.amountMinor.toString(),
          catalog.price.currency,
          catalog.price.periodUnit,
          catalog.price.periodCount,
          input.idempotencyKeyHash,
          input.requestHash,
          input.now,
        ],
      );
      if (inserted.rows[0]) {
        await client.query('COMMIT');
        return { order: mapOrderRow(inserted.rows[0]), created: true };
      }
      const raced = await client.query(
        `SELECT id, user_id, plan_version_id, price_id, product_code,
                plan_version, plan_display_name, price_code, amount_minor,
                currency, period_unit, period_count, status,
                idempotency_key_hash, request_hash, created_at, updated_at
           FROM membership_checkout_orders
          WHERE user_id = $1::uuid AND idempotency_key_hash = $2
          FOR UPDATE`,
        [input.userId, input.idempotencyKeyHash],
      );
      if (!raced.rows[0]) throw referenceInvalid();
      const order = mapOrderRow(raced.rows[0]);
      assertRequestReplay(order.requestHash, input.requestHash);
      await client.query('COMMIT');
      return { order, created: false };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw mapRepositoryError(error);
    } finally {
      client.release();
    }
  }

  async findOrderByIdempotency(userId: string, idempotencyKeyHash: string): Promise<MembershipCheckoutOrder | null> {
    if (!isValidPaymentIdentifier(userId)) return null;
    const result = await this.pool.query(
      `SELECT id, user_id, plan_version_id, price_id, product_code,
              plan_version, plan_display_name, price_code, amount_minor,
              currency, period_unit, period_count, status,
              idempotency_key_hash, request_hash, created_at, updated_at
         FROM membership_checkout_orders
        WHERE user_id = $1::uuid AND idempotency_key_hash = $2`,
      [userId, idempotencyKeyHash],
    );
    return result.rows[0] ? mapOrderRow(result.rows[0]) : null;
  }

  async findOwnedOrder(userId: string, orderId: string): Promise<MembershipCheckoutOrder | null> {
    if (!isValidPaymentIdentifier(userId) || !isValidPaymentIdentifier(orderId)) return null;
    const result = await this.pool.query(
      `SELECT id, user_id, plan_version_id, price_id, product_code,
              plan_version, plan_display_name, price_code, amount_minor,
              currency, period_unit, period_count, status,
              idempotency_key_hash, request_hash, created_at, updated_at
         FROM membership_checkout_orders
        WHERE id = $1::uuid AND user_id = $2::uuid`,
      [orderId, userId],
    );
    return result.rows[0] ? mapOrderRow(result.rows[0]) : null;
  }

  async findLatestAttemptForOrder(userId: string, orderId: string): Promise<MembershipPaymentAttempt | null> {
    if (!isValidPaymentIdentifier(userId) || !isValidPaymentIdentifier(orderId)) return null;
    const result = await this.pool.query(
      `SELECT a.id, a.user_id, a.order_id, a.provider_code,
              a.local_attempt_reference, a.provider_reference, a.checkout_url,
              a.amount_minor, a.currency, a.status, a.idempotency_key_hash,
              a.request_hash, a.expires_at, a.failure_code,
              a.created_at, a.updated_at
         FROM membership_payment_attempts a
         JOIN membership_checkout_orders o ON o.id = a.order_id
        WHERE a.order_id = $1::uuid AND o.user_id = $2::uuid
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT 1`,
      [orderId, userId],
    );
    return result.rows[0] ? mapAttemptRow(result.rows[0]) : null;
  }

  async createAttempt(input: CreateMembershipAttemptInput): Promise<CreateMembershipAttemptResult | null> {
    assertIdentifiers(input.userId, input.orderId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT id, user_id, order_id, provider_code, local_attempt_reference,
                provider_reference, checkout_url, amount_minor, currency, status,
                idempotency_key_hash, request_hash, expires_at, failure_code,
                created_at, updated_at
           FROM membership_payment_attempts
          WHERE user_id = $1::uuid AND idempotency_key_hash = $2
          FOR UPDATE`,
        [input.userId, input.idempotencyKeyHash],
      );
      if (existing.rows[0]) {
        const attempt = mapAttemptRow(existing.rows[0]);
        assertRequestReplay(attempt.requestHash, input.requestHash);
        await client.query('COMMIT');
        return { attempt, shouldCallProvider: false };
      }

      const orderResult = await client.query(
        `SELECT id, user_id, plan_version_id, price_id, product_code,
                plan_version, plan_display_name, price_code, amount_minor,
                currency, period_unit, period_count, status,
                idempotency_key_hash, request_hash, created_at, updated_at
           FROM membership_checkout_orders
          WHERE id = $1::uuid AND user_id = $2::uuid
          FOR UPDATE`,
        [input.orderId, input.userId],
      );
      if (!orderResult.rows[0]) {
        await client.query('COMMIT');
        return null;
      }
      const order = mapOrderRow(orderResult.rows[0]);
      if (order.status !== 'PENDING_PAYMENT' || !isSafeMinorAmount(order.amountMinor)) {
        await client.query('COMMIT');
        throw orderNotPayable();
      }
      await client.query(
        `UPDATE membership_payment_attempts
            SET status = 'EXPIRED'::membership_payment_attempt_status,
                updated_at = $2::timestamptz
          WHERE order_id = $1::uuid
            AND status IN ('CREATED'::membership_payment_attempt_status, 'PENDING'::membership_payment_attempt_status)
            AND expires_at <= $2::timestamptz`,
        [input.orderId, input.now],
      );
      const open = await client.query(
        `SELECT id, user_id, order_id, provider_code, local_attempt_reference,
                provider_reference, checkout_url, amount_minor, currency, status,
                idempotency_key_hash, request_hash, expires_at, failure_code,
                created_at, updated_at
           FROM membership_payment_attempts
          WHERE order_id = $1::uuid
            AND status IN ('CREATED'::membership_payment_attempt_status, 'PENDING'::membership_payment_attempt_status)
            AND expires_at > $2::timestamptz
          ORDER BY created_at DESC, id DESC
          LIMIT 1
          FOR UPDATE`,
        [input.orderId, input.now],
      );
      if (open.rows[0]) {
        await client.query('COMMIT');
        return { attempt: mapAttemptRow(open.rows[0]), shouldCallProvider: false };
      }

      const inserted = await client.query(
        `INSERT INTO membership_payment_attempts (
           user_id, order_id, provider_code, local_attempt_reference,
           amount_minor, currency, status, idempotency_key_hash, request_hash,
           expires_at, created_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $5::bigint,
           $6::membership_payment_currency,
           'CREATED'::membership_payment_attempt_status, $7, $8, $9, $10, $10
         )
         ON CONFLICT (user_id, idempotency_key_hash) DO NOTHING
         RETURNING id, user_id, order_id, provider_code, local_attempt_reference,
                   provider_reference, checkout_url, amount_minor, currency, status,
                   idempotency_key_hash, request_hash, expires_at, failure_code,
                   created_at, updated_at`,
        [
          input.userId,
          input.orderId,
          input.providerCode,
          input.localAttemptReference,
          order.amountMinor.toString(),
          order.currency,
          input.idempotencyKeyHash,
          input.requestHash,
          input.expiresAt,
          input.now,
        ],
      );
      if (inserted.rows[0]) {
        await client.query('COMMIT');
        return { attempt: mapAttemptRow(inserted.rows[0]), shouldCallProvider: true };
      }
      const raced = await client.query(
        `SELECT id, user_id, order_id, provider_code, local_attempt_reference,
                provider_reference, checkout_url, amount_minor, currency, status,
                idempotency_key_hash, request_hash, expires_at, failure_code,
                created_at, updated_at
           FROM membership_payment_attempts
          WHERE user_id = $1::uuid AND idempotency_key_hash = $2
          FOR UPDATE`,
        [input.userId, input.idempotencyKeyHash],
      );
      if (!raced.rows[0]) throw referenceInvalid();
      const attempt = mapAttemptRow(raced.rows[0]);
      assertRequestReplay(attempt.requestHash, input.requestHash);
      await client.query('COMMIT');
      return { attempt, shouldCallProvider: false };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw mapRepositoryError(error);
    } finally {
      client.release();
    }
  }

  async attachProviderCheckout(input: {
    userId: string;
    attemptId: string;
    providerReference: string;
    checkoutUrl: string;
    now: Date;
  }): Promise<MembershipPaymentAttempt | null> {
    return this.updateAttempt(input.userId, input.attemptId, input.now, {
      status: 'PENDING',
      providerReference: input.providerReference,
      checkoutUrl: input.checkoutUrl,
      failureCode: null,
    });
  }

  async markAttemptFailed(input: {
    userId: string;
    attemptId: string;
    failureCode: string;
    now: Date;
  }): Promise<MembershipPaymentAttempt | null> {
    return this.updateAttempt(input.userId, input.attemptId, input.now, {
      status: 'FAILED',
      providerReference: null,
      checkoutUrl: null,
      failureCode: input.failureCode,
    });
  }

  async findOwnedAttempt(userId: string, attemptId: string): Promise<MembershipPaymentAttempt | null> {
    if (!isValidPaymentIdentifier(userId) || !isValidPaymentIdentifier(attemptId)) return null;
    const result = await this.pool.query(
      `SELECT id, user_id, order_id, provider_code, local_attempt_reference,
              provider_reference, checkout_url, amount_minor, currency, status,
              idempotency_key_hash, request_hash, expires_at, failure_code,
              created_at, updated_at
         FROM membership_payment_attempts
        WHERE id = $1::uuid AND user_id = $2::uuid`,
      [attemptId, userId],
    );
    return result.rows[0] ? mapAttemptRow(result.rows[0]) : null;
  }

  private async updateAttempt(
    userId: string,
    attemptId: string,
    now: Date,
    update: {
      status: MembershipPaymentAttemptStatus;
      providerReference: string | null;
      checkoutUrl: string | null;
      failureCode: string | null;
    },
  ): Promise<MembershipPaymentAttempt | null> {
    if (!isValidPaymentIdentifier(userId) || !isValidPaymentIdentifier(attemptId)) return null;
    try {
      const result = await this.pool.query(
        `UPDATE membership_payment_attempts
            SET provider_reference = $3,
                checkout_url = $4,
                status = $5::membership_payment_attempt_status,
                failure_code = $6,
                updated_at = $7::timestamptz
          WHERE id = $1::uuid AND user_id = $2::uuid AND status = 'CREATED'::membership_payment_attempt_status
          RETURNING id, user_id, order_id, provider_code, local_attempt_reference,
                    provider_reference, checkout_url, amount_minor, currency, status,
                    idempotency_key_hash, request_hash, expires_at, failure_code,
                    created_at, updated_at`,
        [attemptId, userId, update.providerReference, update.checkoutUrl, update.status, update.failureCode, now],
      );
      if (result.rows[0]) return mapAttemptRow(result.rows[0]);
      return this.findOwnedAttempt(userId, attemptId);
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }
}

async function queryCatalog(
  client: PoolClient,
  planVersionId: string,
  priceId: string,
  now: Date,
): Promise<MembershipPaymentCatalogEntry | null> {
  const result = await client.query(
    `SELECT mpv.id AS plan_version_id,
            mp.product_code,
            mp.status AS product_status,
            mpv.version AS plan_version,
            mpv.status AS plan_status,
            mpv.display_name AS plan_display_name,
            mpp.id AS price_id,
            mpp.price_code,
            mpp.status AS price_status,
            mpp.amount_minor,
            mpp.currency,
            mpp.period_unit,
            mpp.period_count,
            mpp.available_from,
            mpp.available_until,
            mpp.created_at AS price_created_at
       FROM membership_plan_prices mpp
       JOIN membership_plan_versions mpv ON mpv.id = mpp.plan_version_id
       JOIN membership_products mp ON mp.id = mpv.product_id
      WHERE mpv.id = $1::uuid
        AND mpp.id = $2::uuid
        AND mp.status = 'ACTIVE'::membership_product_status
        AND mpv.status = 'ACTIVE'::membership_plan_version_status
        AND mpp.status = 'ACTIVE'::membership_price_status
        AND mpp.available_from <= $3::timestamptz
        AND (mpp.available_until IS NULL OR mpp.available_until > $3::timestamptz)
      FOR SHARE OF mpp`,
    [planVersionId, priceId, now],
  );
  return result.rows[0] ? mapCatalogRow(result.rows[0]) : null;
}

function mapCatalogRow(row: Record<string, unknown>): MembershipPaymentCatalogEntry {
  const amountMinor = toMinorUnits(row.amount_minor);
  const currency = String(row.currency);
  const periodUnit = String(row.period_unit) as MembershipPricePeriodUnit;
  const price: MembershipPlanPrice = {
    id: String(row.price_id),
    planVersionId: String(row.plan_version_id),
    code: String(row.price_code),
    status: String(row.price_status) as MembershipPlanPrice['status'],
    amountMinor,
    currency: currency as MembershipPaymentCurrency,
    periodUnit,
    periodCount: Number(row.period_count),
    availableFrom: toDate(row.available_from),
    availableUntil: row.available_until ? toDate(row.available_until) : null,
    createdAt: toDate(row.price_created_at),
  };
  const result: MembershipPaymentCatalogEntry = {
    planVersionId: String(row.plan_version_id),
    productCode: String(row.product_code),
    productStatus: String(row.product_status) as MembershipPaymentCatalogEntry['productStatus'],
    planVersion: Number(row.plan_version),
    planStatus: String(row.plan_status) as MembershipPaymentCatalogEntry['planStatus'],
    planDisplayName: String(row.plan_display_name),
    price,
  };
  if (!isCatalogEntryShapeValid(result)) throw referenceInvalid();
  return result;
}

function mapOrderRow(row: Record<string, unknown>): MembershipCheckoutOrder {
  const order: MembershipCheckoutOrder = {
    id: String(row.id),
    userId: String(row.user_id),
    planVersionId: String(row.plan_version_id),
    priceId: String(row.price_id),
    productCode: String(row.product_code),
    planVersion: Number(row.plan_version),
    planDisplayName: String(row.plan_display_name),
    priceCode: String(row.price_code),
    amountMinor: toMinorUnits(row.amount_minor),
    currency: String(row.currency) as MembershipPaymentCurrency,
    periodUnit: String(row.period_unit) as MembershipPricePeriodUnit,
    periodCount: Number(row.period_count),
    status: String(row.status) as MembershipOrderStatus,
    idempotencyKeyHash: String(row.idempotency_key_hash),
    requestHash: String(row.request_hash),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
  if (!isSafeMinorAmount(order.amountMinor)) throw referenceInvalid();
  return order;
}

function mapAttemptRow(row: Record<string, unknown>): MembershipPaymentAttempt {
  const attempt: MembershipPaymentAttempt = {
    id: String(row.id),
    userId: String(row.user_id),
    orderId: String(row.order_id),
    providerCode: String(row.provider_code),
    localAttemptReference: String(row.local_attempt_reference),
    providerReference: row.provider_reference ? String(row.provider_reference) : null,
    checkoutUrl: row.checkout_url ? String(row.checkout_url) : null,
    amountMinor: toMinorUnits(row.amount_minor),
    currency: String(row.currency) as MembershipPaymentCurrency,
    status: String(row.status) as MembershipPaymentAttemptStatus,
    idempotencyKeyHash: String(row.idempotency_key_hash),
    requestHash: String(row.request_hash),
    expiresAt: toDate(row.expires_at),
    failureCode: row.failure_code ? String(row.failure_code) : null,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
  if (!isSafeMinorAmount(attempt.amountMinor)) throw referenceInvalid();
  return attempt;
}

function isCatalogEntryPurchasable(entry: MembershipPaymentCatalogEntry, now: Date): boolean {
  return (
    entry.productStatus === 'ACTIVE' &&
    entry.planStatus === 'ACTIVE' &&
    entry.price.status === 'ACTIVE' &&
    entry.price.availableFrom.getTime() <= now.getTime() &&
    (!entry.price.availableUntil || entry.price.availableUntil.getTime() > now.getTime()) &&
    isCatalogEntryShapeValid(entry)
  );
}

function isCatalogEntryShapeValid(entry: MembershipPaymentCatalogEntry): boolean {
  return (
    isValidPaymentIdentifier(entry.planVersionId) &&
    isValidPaymentIdentifier(entry.price.id) &&
    entry.price.planVersionId === entry.planVersionId &&
    entry.productCode.length >= 1 && entry.productCode.length <= 64 &&
    Number.isSafeInteger(entry.planVersion) && entry.planVersion > 0 &&
    entry.planDisplayName.trim().length > 0 && entry.planDisplayName.length <= 120 &&
    entry.price.code.length >= 1 && entry.price.code.length <= 64 &&
    isSafeMinorAmount(entry.price.amountMinor) &&
    entry.price.currency === 'VND' &&
    Number.isSafeInteger(entry.price.periodCount) && entry.price.periodCount > 0 &&
    Number.isFinite(entry.price.availableFrom.getTime()) &&
    (!entry.price.availableUntil || Number.isFinite(entry.price.availableUntil.getTime()))
  );
}

function assertIdentifiers(...values: string[]): void {
  if (values.some((value) => !isValidPaymentIdentifier(value))) throw referenceInvalid();
}

function assertRequestReplay(existingHash: string, requestHash: string): void {
  if (existingHash !== requestHash) {
    throw new MembershipPaymentRepositoryError(
      'IDEMPOTENCY_CONFLICT',
      'Payment idempotency key was reused with different facts',
    );
  }
}

function productUnavailable(): MembershipPaymentRepositoryError {
  return new MembershipPaymentRepositoryError(
    'PRODUCT_UNAVAILABLE',
    'Membership product is not available for purchase',
  );
}

function orderNotPayable(): MembershipPaymentRepositoryError {
  return new MembershipPaymentRepositoryError(
    'ORDER_NOT_PAYABLE',
    'Membership order is not eligible for a payment attempt',
  );
}

function referenceInvalid(): MembershipPaymentRepositoryError {
  return new MembershipPaymentRepositoryError(
    'REFERENCE_INVALID',
    'Payment persistence reference is invalid',
  );
}

function mapRepositoryError(error: unknown): Error {
  if (error instanceof MembershipPaymentRepositoryError) return error;
  if (isPostgresError(error)) {
    if (error.code === '23505' && error.constraint?.includes('idempotency')) {
      return new MembershipPaymentRepositoryError(
        'IDEMPOTENCY_CONFLICT',
        'Payment idempotency key was reused with different facts',
      );
    }
    if (error.code === '23514' || error.code === '22P02' || error.code === '23503') return referenceInvalid();
  }
  return error instanceof Error ? error : new Error('Payment persistence failed');
}

function isPostgresError(error: unknown): error is { code: string; constraint?: string } {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string';
}

function toMinorUnits(value: unknown): bigint {
  try {
    const result = typeof value === 'bigint' ? value : BigInt(String(value));
    if (!isSafeMinorAmount(result) || result > MAX_SAFE_MINOR_UNITS) throw new Error();
    return result;
  } catch {
    throw referenceInvalid();
  }
}

function toDate(value: unknown): Date {
  const date = value instanceof Date ? new Date(value) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw referenceInvalid();
  return date;
}

function isOpenAttempt(attempt: MembershipPaymentAttempt, now: Date): boolean {
  return (attempt.status === 'CREATED' || attempt.status === 'PENDING') && attempt.expiresAt.getTime() > now.getTime();
}

function compareNewest(left: { createdAt: Date; id: string }, right: { createdAt: Date; id: string }): number {
  const byTime = right.createdAt.getTime() - left.createdAt.getTime();
  return byTime !== 0 ? byTime : right.id.localeCompare(left.id);
}
