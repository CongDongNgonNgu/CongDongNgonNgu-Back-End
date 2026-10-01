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
import { createHash } from 'node:crypto';
import { isValidPaymentIdentifier } from './membership.payment.types';
import {
  MEMBERSHIP_FULFILLMENT_REPOSITORY,
  MembershipFulfillmentRepositoryError,
  type MembershipFulfillmentRepository,
} from './membership.fulfillment.repository';
import {
  type MembershipFulfillmentOutcome,
  type MembershipWebhookProcessingResult,
  type RedeemMembershipCreditInput,
} from './membership.fulfillment.types';
import { PAYOS_PROVIDER_CODE } from './membership.fulfillment.types';
import {
  MEMBERSHIP_WEBHOOK_VERIFIER,
  MembershipWebhookValidationError,
  type MembershipWebhookVerifier,
} from './membership.webhook';
import {
  createNotificationDomainEvent,
  NOTIFICATION_DOMAIN_EVENT_SINK,
  type NotificationDomainEventSink,
} from '../notifications/notification-event-integration';

export const MEMBERSHIP_FULFILLMENT_CLOCK = 'MEMBERSHIP_FULFILLMENT_CLOCK';

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{8,128}$/u;

export interface MembershipWebhookResponse {
  accepted: boolean;
  outcome: MembershipFulfillmentOutcome;
  retryable: boolean;
}

export interface MembershipCreditRedemptionResponse {
  created: boolean;
  creditUnits: number;
  plan: {
    productCode: string;
    version: number;
  };
  membership: {
    status: 'ACTIVE';
    startsAt: string;
    endsAt: string;
  };
}

@Injectable()
export class MembershipFulfillmentService {
  constructor(
    @Inject(MEMBERSHIP_FULFILLMENT_REPOSITORY)
    private readonly repository: MembershipFulfillmentRepository,
    @Inject(MEMBERSHIP_WEBHOOK_VERIFIER)
    private readonly webhookVerifier: MembershipWebhookVerifier,
    @Optional()
    @Inject(MEMBERSHIP_FULFILLMENT_CLOCK)
    private readonly clock: () => Date = () => new Date(),
    @Optional() @Inject(NOTIFICATION_DOMAIN_EVENT_SINK)
    private readonly notificationEvents?: NotificationDomainEventSink,
  ) {}

  async handlePayOsWebhook(payload: unknown): Promise<MembershipWebhookResponse> {
    let verified;
    try {
      verified = this.webhookVerifier.verify(payload);
    } catch (error) {
      throw this.mapWebhookValidationError(error);
    }
    const now = this.currentTime();
    let recorded: MembershipWebhookProcessingResult;
    try {
      recorded = await this.repository.recordVerifiedWebhook(verified, now);
    } catch (error) {
      throw this.mapRepositoryError(error);
    }

    let result = recorded;
    if (recorded.settlementId) {
      try {
        result = await this.repository.fulfillSettlement(recorded.settlementId, now);
      } catch {
        return {
          accepted: false,
          outcome: 'FULFILLMENT_RETRYABLE',
          retryable: true,
        };
      }
    }
    await this.publishFulfillmentNotifications(result, recorded.settlementId);
    return {
      accepted: result.outcome === 'FULFILLED' ||
        result.outcome === 'REPLAYED' ||
        result.outcome === 'PAYMENT_FAILED',
      outcome: result.outcome,
      retryable: result.outcome === 'FULFILLMENT_RETRYABLE',
    };
  }

  async redeemContributionCredit(
    userId: string,
    idempotencyKey: string | undefined,
    input: { planVersionId: string; creditUnits: number },
  ): Promise<MembershipCreditRedemptionResponse> {
    if (!isValidPaymentIdentifier(userId)) {
      throw new BadRequestException({ code: 'MEMBERSHIP_CREDIT_USER_INVALID', message: 'Authenticated user is invalid.' });
    }
    if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new BadRequestException({
        code: 'MEMBERSHIP_CREDIT_IDEMPOTENCY_KEY_INVALID',
        message: 'Idempotency-Key must be 8-128 printable ASCII characters.',
      });
    }
    if (
      !isValidPaymentIdentifier(input?.planVersionId) ||
      !Number.isSafeInteger(input?.creditUnits) ||
      input.creditUnits < 1 ||
      input.creditUnits > 120
    ) {
      throw new BadRequestException({
        code: 'MEMBERSHIP_CREDIT_REDEMPTION_INVALID',
        message: 'Membership credit redemption is invalid.',
      });
    }
    const now = this.currentTime();
    const request: RedeemMembershipCreditInput = {
      userId,
      planVersionId: input.planVersionId,
      creditUnits: input.creditUnits,
      idempotencyKeyHash: digest(idempotencyKey),
      requestHash: digest(`${input.planVersionId}\n${input.creditUnits}`),
      now,
    };
    try {
      const result = await this.repository.redeemContributionCredit(request);
      await this.publishMembershipActivatedNotification(
        result.subscription,
        'MEMBERSHIP',
        result.subscription.id,
      );
      return {
        created: result.created,
        creditUnits: result.creditUnits,
        plan: {
          productCode: result.plan.productCode,
          version: result.plan.version,
        },
        membership: {
          status: 'ACTIVE',
          startsAt: result.subscription.startsAt.toISOString(),
          endsAt: result.subscription.endsAt!.toISOString(),
        },
      };
    } catch (error) {
      throw this.mapRepositoryError(error);
    }
  }

  private currentTime(): Date {
    const now = this.clock();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new InternalServerErrorException({
        code: 'MEMBERSHIP_TIME_INVALID',
        message: 'Membership operation time is invalid.',
      });
    }
    return new Date(now);
  }

  private async publishFulfillmentNotifications(
    result: MembershipWebhookProcessingResult,
    settlementId: string | null,
  ): Promise<void> {
    if (!this.notificationEvents || !result.subscription) return;
    if (result.outcome !== 'FULFILLED' && result.outcome !== 'REPLAYED') return;
    await this.publishMembershipActivatedNotification(
      result.subscription,
      PAYOS_PROVIDER_CODE.toUpperCase(),
      result.subscription.id,
    );
    if (settlementId) {
      await this.notificationEvents.publish(createNotificationDomainEvent({
        eventId: settlementId,
        eventType: 'membership.payment.fulfilled',
        aggregateType: 'MEMBERSHIP_SUBSCRIPTION',
        aggregateId: result.subscription.id,
        actor: { kind: 'PROVIDER', code: PAYOS_PROVIDER_CODE.toUpperCase() },
        recipientUserId: result.subscription.userId,
        occurredAt: result.subscription.createdAt,
        idempotencyKey: `membership.payment.fulfilled:${settlementId}:v1`,
        target: {
          kind: 'MEMBERSHIP_SUBSCRIPTION',
          id: result.subscription.id,
          path: '/membership',
        },
        variables: { paymentState: 'FULFILLED' },
      }));
    }
  }

  private async publishMembershipActivatedNotification(
    subscription: NonNullable<MembershipWebhookProcessingResult['subscription']>,
    actorCode: string,
    eventId: string,
  ): Promise<void> {
    if (!this.notificationEvents) return;
    const actor = actorCode === PAYOS_PROVIDER_CODE.toUpperCase()
      ? { kind: 'PROVIDER' as const, code: actorCode }
      : { kind: 'SYSTEM' as const, code: actorCode };
    await this.notificationEvents.publish(createNotificationDomainEvent({
      eventId,
      eventType: 'membership.subscription.activated',
      aggregateType: 'MEMBERSHIP_SUBSCRIPTION',
      aggregateId: subscription.id,
      actor,
      recipientUserId: subscription.userId,
      occurredAt: subscription.createdAt,
      idempotencyKey: `membership.subscription.activated:${subscription.id}:v1`,
      target: {
        kind: 'MEMBERSHIP_SUBSCRIPTION',
        id: subscription.id,
        path: '/membership',
      },
      variables: { membershipState: 'ACTIVE' },
    }));
  }

  private mapWebhookValidationError(error: unknown): Error {
    if (error instanceof MembershipWebhookValidationError) {
      if (error.code === 'WEBHOOK_UNAVAILABLE') {
        return new ServiceUnavailableException({
          code: 'MEMBERSHIP_WEBHOOK_UNAVAILABLE',
          message: 'Payment webhook processing is temporarily unavailable.',
        });
      }
      return new BadRequestException({
        code: 'MEMBERSHIP_WEBHOOK_REJECTED',
        message: 'Payment webhook could not be verified.',
      });
    }
    return new BadRequestException({
      code: 'MEMBERSHIP_WEBHOOK_REJECTED',
      message: 'Payment webhook could not be verified.',
    });
  }

  private mapRepositoryError(error: unknown): Error {
    if (error instanceof MembershipFulfillmentRepositoryError) {
      switch (error.code) {
        case 'IDEMPOTENCY_CONFLICT':
          return new ConflictException({
            code: 'MEMBERSHIP_CREDIT_IDEMPOTENCY_CONFLICT',
            message: 'Idempotency-Key was reused with different membership credit facts.',
          });
        case 'CREDIT_INSUFFICIENT':
          return new ConflictException({
            code: 'MEMBERSHIP_CREDIT_INSUFFICIENT',
            message: 'Contribution credit is insufficient for this membership period.',
          });
        case 'MEMBERSHIP_ALREADY_ACTIVE':
          return new ConflictException({
            code: 'MEMBERSHIP_ALREADY_ACTIVE',
            message: 'An active membership already exists.',
          });
        case 'PLAN_UNAVAILABLE':
          return new NotFoundException({
            code: 'MEMBERSHIP_PLAN_UNAVAILABLE',
            message: 'The selected membership plan is unavailable.',
          });
        default:
          return new InternalServerErrorException({
            code: 'MEMBERSHIP_FULFILLMENT_UNAVAILABLE',
            message: 'Membership fulfillment could not be completed safely.',
          });
      }
    }
    return new InternalServerErrorException({
      code: 'MEMBERSHIP_FULFILLMENT_UNAVAILABLE',
      message: 'Membership fulfillment could not be completed safely.',
    });
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
