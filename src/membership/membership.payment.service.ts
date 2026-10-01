import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MembershipAuthorizationService } from './membership.service';
import { getFreePublicMembershipBenefits } from './membership.policy';
import {
  MEMBERSHIP_PAYMENT_REPOSITORY,
  MembershipPaymentRepositoryError,
  type CreateMembershipAttemptInput,
  type CreateMembershipOrderInput,
  type MembershipPaymentRepository,
} from './membership.payment.repository';
import {
  MEMBERSHIP_PAYMENT_PROVIDER,
  MembershipPaymentProviderError,
  type MembershipPaymentProvider,
} from './membership.payment-provider';
import {
  isSafeMinorAmount,
  isValidPaymentIdentifier,
  PAYMENT_ATTEMPT_LIFETIME_MS,
  serializeMinorAmount,
  validateProviderCheckout,
  type MembershipCheckoutOrder,
  type MembershipCheckoutOrderResponse,
  type MembershipPaymentAttempt,
  type MembershipPaymentAttemptResponse,
  type MembershipCatalogResponse,
} from './membership.payment.types';

export const MEMBERSHIP_PAYMENT_CLOCK = 'MEMBERSHIP_PAYMENT_CLOCK';

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{8,128}$/u;

export interface CreateMembershipOrderRequest {
  planVersionId: string;
  priceId: string;
}

@Injectable()
export class MembershipPaymentService {
  constructor(
    @Inject(MEMBERSHIP_PAYMENT_REPOSITORY)
    private readonly repository: MembershipPaymentRepository,
    @Inject(MEMBERSHIP_PAYMENT_PROVIDER)
    private readonly provider: MembershipPaymentProvider,
    private readonly memberships: MembershipAuthorizationService,
    @Optional()
    @Inject(MEMBERSHIP_PAYMENT_CLOCK)
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async getCatalog(now = this.currentTime()): Promise<MembershipCatalogResponse> {
    const entries = await this.repository.listPurchasableCatalogEntries(now);
    const plans = await Promise.all(entries
      .filter((entry) => entry.productCode !== 'FREE')
      .map(async (entry) => ({
        planVersionId: entry.planVersionId,
        productCode: entry.productCode,
        planVersion: entry.planVersion,
        displayName: entry.planDisplayName,
        description: entry.planDescription?.trim() || `Gói ${entry.planDisplayName} theo cấu hình hiện hành.`,
        benefits: await this.memberships.listPublicPlanBenefits(entry.planVersionId),
        price: {
          id: entry.price.id,
          code: entry.price.code,
          amountMinor: serializeMinorAmount(entry.price.amountMinor),
          currency: entry.price.currency,
          periodUnit: entry.price.periodUnit,
          periodCount: entry.price.periodCount,
        },
      })));

    return {
      free: {
        productCode: 'FREE',
        planVersion: 1,
        displayName: 'Free',
        description: 'Bắt đầu học và kết nối cộng đồng mà không cần gói trả phí.',
        benefits: getFreePublicMembershipBenefits(),
      },
      plans,
      evaluatedAt: now.toISOString(),
    };
  }

  async createOrder(
    userId: string,
    idempotencyKey: string | undefined,
    input: CreateMembershipOrderRequest,
  ): Promise<{ order: MembershipCheckoutOrderResponse; created: boolean }> {
    this.assertUserId(userId);
    const key = this.assertIdempotencyKey(idempotencyKey);
    this.assertOrderInput(input);
    const now = this.currentTime();
    const idempotencyKeyHash = digest(key);
    const requestHash = digest(`${input.planVersionId}\n${input.priceId}`);
    const existing = await this.repository.findOrderByIdempotency(userId, idempotencyKeyHash);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ConflictException({
          code: 'PAYMENT_IDEMPOTENCY_KEY_REUSED',
          message: 'Idempotency-Key was reused with different payment facts.',
        });
      }
      return {
        order: this.toOrderResponse(existing, null),
        created: false,
      };
    }
    const membership = await this.memberships.getCapabilityProjection(userId, now);
    if (
      membership.plan.productCode !== 'FREE' &&
      (membership.membership.status === 'ACTIVE' || membership.membership.status === 'SCHEDULED')
    ) {
      throw new ConflictException({
        code: 'MEMBERSHIP_CHANGE_NOT_SUPPORTED',
        message: 'An active membership change is not available yet.',
      });
    }

    const request: CreateMembershipOrderInput = {
      userId,
      planVersionId: input.planVersionId,
      priceId: input.priceId,
      idempotencyKeyHash,
      requestHash,
      now,
    };
    try {
      const result = await this.repository.createOrder(request);
      if (!isSafeMinorAmount(result.order.amountMinor)) throw this.configurationInvalid();
      return {
        order: this.toOrderResponse(result.order, null),
        created: result.created,
      };
    } catch (error) {
      throw this.mapRepositoryError(error);
    }
  }

  async createPaymentAttempt(
    userId: string,
    orderId: string,
    idempotencyKey: string | undefined,
  ): Promise<MembershipPaymentAttemptResponse> {
    this.assertUserId(userId);
    this.assertIdentifier(orderId, 'PAYMENT_ORDER_NOT_FOUND');
    const key = this.assertIdempotencyKey(idempotencyKey);
    const now = this.currentTime();
    const order = await this.repository.findOwnedOrder(userId, orderId);
    if (!order) throw this.orderNotFound();
    const request: CreateMembershipAttemptInput = {
      userId,
      orderId,
      providerCode: this.provider.code,
      localAttemptReference: `cdn-mpay-${randomUUID()}`,
      idempotencyKeyHash: digest(key),
      requestHash: digest(orderId),
      expiresAt: new Date(now.getTime() + PAYMENT_ATTEMPT_LIFETIME_MS),
      now,
    };
    let prepared;
    try {
      prepared = await this.repository.createAttempt(request);
    } catch (error) {
      throw this.mapRepositoryError(error);
    }
    if (!prepared) throw this.orderNotFound();
    if (!prepared.shouldCallProvider) return this.toAttemptResponse(prepared.attempt);

    if (!this.provider.isAvailable()) {
      await this.repository.markAttemptFailed({
        userId,
        attemptId: prepared.attempt.id,
        failureCode: this.provider.code === 'disabled' ? 'PROVIDER_DISABLED' : 'PROVIDER_UNAVAILABLE',
        now: this.currentTime(),
      });
      throw this.providerUnavailable(this.provider.code === 'disabled');
    }

    let created;
    try {
      created = await this.provider.createCheckout({
        localAttemptReference: prepared.attempt.localAttemptReference,
        amountMinor: prepared.attempt.amountMinor,
        currency: prepared.attempt.currency,
        description: `CongDongNgonNgu ${order.productCode} v${order.planVersion}`,
        expiresAt: prepared.attempt.expiresAt,
      });
      validateProviderCheckout(created, {
        amountMinor: prepared.attempt.amountMinor,
        currency: prepared.attempt.currency,
      });
      if (
        created.amountMinor !== undefined && created.amountMinor !== prepared.attempt.amountMinor
      ) throw new MembershipPaymentProviderError('MALFORMED_RESPONSE', false);
      if (created.currency !== undefined && created.currency !== prepared.attempt.currency) {
        throw new MembershipPaymentProviderError('MALFORMED_RESPONSE', false);
      }
    } catch (error) {
      await this.repository.markAttemptFailed({
        userId,
        attemptId: prepared.attempt.id,
        failureCode: this.providerFailureCode(error),
        now: this.currentTime(),
      });
      throw this.mapProviderError(error);
    }

    let completed;
    try {
      completed = await this.repository.attachProviderCheckout({
        userId,
        attemptId: prepared.attempt.id,
        providerReference: created.providerReference,
        checkoutUrl: created.checkoutUrl,
        now: this.currentTime(),
      });
    } catch (error) {
      throw this.mapRepositoryError(error);
    }
    if (!completed) throw this.attemptStateUnavailable();
    return this.toAttemptResponse(completed);
  }

  async getOrder(userId: string, orderId: string): Promise<MembershipCheckoutOrderResponse> {
    this.assertUserId(userId);
    this.assertIdentifier(orderId, 'PAYMENT_ORDER_NOT_FOUND');
    const order = await this.repository.findOwnedOrder(userId, orderId);
    if (!order) throw this.orderNotFound();
    const attempt = await this.repository.findLatestAttemptForOrder(userId, orderId);
    return this.toOrderResponse(order, attempt);
  }

  async getAttempt(userId: string, attemptId: string): Promise<MembershipPaymentAttemptResponse> {
    this.assertUserId(userId);
    this.assertIdentifier(attemptId, 'PAYMENT_ATTEMPT_NOT_FOUND');
    const attempt = await this.repository.findOwnedAttempt(userId, attemptId);
    if (!attempt) throw this.attemptNotFound();
    return this.toAttemptResponse(attempt);
  }

  private toOrderResponse(
    order: MembershipCheckoutOrder,
    attempt: MembershipPaymentAttempt | null,
  ): MembershipCheckoutOrderResponse {
    return {
      id: order.id,
      status: order.status,
      product: {
        code: order.productCode,
        planVersion: order.planVersion,
        displayName: order.planDisplayName,
      },
      price: {
        code: order.priceCode,
        amountMinor: serializeMinorAmount(order.amountMinor),
        currency: order.currency,
        periodUnit: order.periodUnit,
        periodCount: order.periodCount,
      },
      createdAt: order.createdAt.toISOString(),
      updatedAt: order.updatedAt.toISOString(),
      attempt: attempt ? this.toAttemptResponse(attempt) : null,
    };
  }

  private toAttemptResponse(attempt: MembershipPaymentAttempt): MembershipPaymentAttemptResponse {
    return {
      id: attempt.id,
      orderId: attempt.orderId,
      status: attempt.status,
      amountMinor: serializeMinorAmount(attempt.amountMinor),
      currency: attempt.currency,
      checkoutUrl: attempt.checkoutUrl,
      expiresAt: attempt.expiresAt.toISOString(),
    };
  }

  private assertUserId(userId: string): void {
    if (!isValidPaymentIdentifier(userId)) {
      throw new BadRequestException({ code: 'PAYMENT_USER_INVALID', message: 'Authenticated user is invalid.' });
    }
  }

  private assertIdentifier(value: string, code: string): void {
    if (!isValidPaymentIdentifier(value)) throw new NotFoundException({ code, message: 'Payment resource was not found.' });
  }

  private assertOrderInput(input: CreateMembershipOrderRequest): void {
    if (!input || !isValidPaymentIdentifier(input.planVersionId) || !isValidPaymentIdentifier(input.priceId)) {
      throw new BadRequestException({ code: 'PAYMENT_PRODUCT_INVALID', message: 'Membership product selection is invalid.' });
    }
  }

  private assertIdempotencyKey(key: string | undefined): string {
    if (!key || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw new BadRequestException({
        code: 'PAYMENT_IDEMPOTENCY_KEY_INVALID',
        message: 'Idempotency-Key must be 8-128 printable ASCII characters.',
      });
    }
    return key;
  }

  private currentTime(): Date {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw this.configurationInvalid();
    }
    return new Date(now);
  }

  private mapRepositoryError(error: unknown): Error {
    if (!(error instanceof MembershipPaymentRepositoryError)) return this.persistenceUnavailable();
    switch (error.code) {
      case 'IDEMPOTENCY_CONFLICT':
        return new ConflictException({
          code: 'PAYMENT_IDEMPOTENCY_KEY_REUSED',
          message: 'Idempotency-Key was reused with different payment facts.',
        });
      case 'PRODUCT_UNAVAILABLE':
        return this.productUnavailable();
      case 'ORDER_NOT_PAYABLE':
        return new ConflictException({
          code: 'PAYMENT_ORDER_NOT_PAYABLE',
          message: 'Membership order is not eligible for a payment attempt.',
        });
      default:
        return this.persistenceUnavailable();
    }
  }

  private mapProviderError(error: unknown): Error {
    if (error instanceof MembershipPaymentProviderError) {
      if (error.code === 'DISABLED') return this.providerUnavailable(true);
      if (error.code === 'MALFORMED_RESPONSE' || error.code === 'INVALID_REQUEST') {
        return new ServiceUnavailableException({
          code: 'PAYMENT_PROVIDER_RESPONSE_INVALID',
          message: 'Payment provider response could not be accepted.',
        });
      }
    }
    if (error instanceof Error && error.message === 'Invalid payment provider response') {
      return new ServiceUnavailableException({
        code: 'PAYMENT_PROVIDER_RESPONSE_INVALID',
        message: 'Payment provider response could not be accepted.',
      });
    }
    return this.providerUnavailable(false);
  }

  private providerFailureCode(error: unknown): string {
    if (error instanceof MembershipPaymentProviderError) {
      return `PROVIDER_${error.code}`;
    }
    return 'PROVIDER_RESPONSE_INVALID';
  }

  private productUnavailable(): NotFoundException {
    return new NotFoundException({
      code: 'MEMBERSHIP_PRODUCT_UNAVAILABLE',
      message: 'The selected membership product is not available for purchase.',
    });
  }

  private orderNotFound(): NotFoundException {
    return new NotFoundException({ code: 'PAYMENT_ORDER_NOT_FOUND', message: 'Payment order was not found.' });
  }

  private attemptNotFound(): NotFoundException {
    return new NotFoundException({ code: 'PAYMENT_ATTEMPT_NOT_FOUND', message: 'Payment attempt was not found.' });
  }

  private providerUnavailable(disabled: boolean): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: disabled ? 'PAYMENT_PROVIDER_DISABLED' : 'PAYMENT_PROVIDER_UNAVAILABLE',
      message: disabled
        ? 'Payment is not enabled yet. Please try again later.'
        : 'Payment is temporarily unavailable. Please try again later.',
    });
  }

  private attemptStateUnavailable(): InternalServerErrorException {
    return new InternalServerErrorException({
      code: 'PAYMENT_ATTEMPT_STATE_UNAVAILABLE',
      message: 'Payment attempt state could not be confirmed.',
    });
  }

  private persistenceUnavailable(): InternalServerErrorException {
    return new InternalServerErrorException({
      code: 'PAYMENT_PERSISTENCE_UNAVAILABLE',
      message: 'Payment could not be processed safely.',
    });
  }

  private configurationInvalid(): InternalServerErrorException {
    return new InternalServerErrorException({
      code: 'PAYMENT_CONFIGURATION_INVALID',
      message: 'Payment configuration is invalid.',
    });
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
