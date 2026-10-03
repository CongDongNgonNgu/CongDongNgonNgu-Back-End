import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { AuthModule } from '../auth/auth.module';
import { ReputationModule } from '../reputation/reputation.module';
import { NotificationModule } from '../notifications/notification.module';
import {
  InMemoryMembershipRepository,
  MEMBERSHIP_REPOSITORY,
  PostgresMembershipRepository,
} from './membership.repository';
import { MembershipController } from './membership.controller';
import { MembershipContributionCreditService } from './membership.contribution-credit';
import {
  InMemoryMembershipFulfillmentRepository,
  MEMBERSHIP_FULFILLMENT_REPOSITORY,
  PostgresMembershipFulfillmentRepository,
} from './membership.fulfillment.repository';
import {
  MEMBERSHIP_FULFILLMENT_CLOCK,
  MembershipFulfillmentService,
} from './membership.fulfillment.service';
import {
  MEMBERSHIP_WEBHOOK_VERIFIER,
  PayOsMembershipWebhookVerifier,
  UnavailableMembershipWebhookVerifier,
} from './membership.webhook';
import {
  createDisabledMembershipPaymentProvider,
  MEMBERSHIP_PAYMENT_PROVIDER,
} from './membership.payment-provider';
import { PayOsMembershipPaymentProvider } from './payos-payment-provider';
import {
  InMemoryMembershipPaymentRepository,
  MEMBERSHIP_PAYMENT_REPOSITORY,
  PostgresMembershipPaymentRepository,
} from './membership.payment.repository';
import { MEMBERSHIP_PAYMENT_CLOCK, MembershipPaymentService } from './membership.payment.service';
import { MembershipPolicyService } from './membership.policy';
import { MembershipAuthorizationService } from './membership.service';
import type { RuntimeConfig } from '../config/configuration';

interface MembershipRuntimeConfig {
  persistence: 'postgres' | 'memory';
}

@Module({
  imports: [AuthModule, ReputationModule, NotificationModule],
  controllers: [MembershipController],
  providers: [
    MembershipAuthorizationService,
    MembershipPolicyService,
    MembershipContributionCreditService,
    MembershipPaymentService,
    MembershipFulfillmentService,
    {
      provide: MEMBERSHIP_FULFILLMENT_CLOCK,
      useFactory: () => () => new Date(),
    },
    {
      provide: MEMBERSHIP_PAYMENT_CLOCK,
      useFactory: () => () => new Date(),
    },
    {
      provide: MEMBERSHIP_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const auth = config.get<MembershipRuntimeConfig>('auth');
        if (auth?.persistence === 'memory') return new InMemoryMembershipRepository();
        const databaseUrl = config.get<string>('database.url');
        if (!databaseUrl) {
          throw new Error('DATABASE_URL is required for Postgres membership persistence');
        }
        return new PostgresMembershipRepository(new Pool({ connectionString: databaseUrl }));
      },
    },
    {
      provide: MEMBERSHIP_PAYMENT_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const auth = config.get<MembershipRuntimeConfig>('auth');
        if (auth?.persistence === 'memory') return new InMemoryMembershipPaymentRepository();
        const databaseUrl = config.get<string>('database.url');
        if (!databaseUrl) {
          throw new Error('DATABASE_URL is required for Postgres membership payment persistence');
        }
        return new PostgresMembershipPaymentRepository(new Pool({ connectionString: databaseUrl }));
      },
    },
    {
      provide: MEMBERSHIP_PAYMENT_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const providers = config.get<RuntimeConfig['providers']>('providers');
        if (providers?.payment !== 'payos') return createDisabledMembershipPaymentProvider(false);
        return new PayOsMembershipPaymentProvider({
          apiUrl: providers.payosApiUrl,
          clientId: providers.payosClientId,
          apiKey: providers.payosApiKey,
          checksumKey: providers.payosChecksumKey,
          qrEnabled: providers.paymentQrEnabled,
        });
      },
    },
    {
      provide: MEMBERSHIP_FULFILLMENT_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const auth = config.get<MembershipRuntimeConfig>('auth');
        if (auth?.persistence === 'memory') return new InMemoryMembershipFulfillmentRepository();
        const databaseUrl = config.get<string>('database.url');
        if (!databaseUrl) {
          throw new Error('DATABASE_URL is required for Postgres membership fulfillment persistence');
        }
        return new PostgresMembershipFulfillmentRepository(new Pool({ connectionString: databaseUrl }));
      },
    },
    {
      provide: MEMBERSHIP_WEBHOOK_VERIFIER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const providers = config.get<RuntimeConfig['providers']>('providers');
        const checksumKey = providers?.payosChecksumKey;
        if (providers?.payment === 'payos' && checksumKey) return new PayOsMembershipWebhookVerifier(checksumKey);
        return new UnavailableMembershipWebhookVerifier();
      },
    },
  ],
  exports: [
    MEMBERSHIP_REPOSITORY,
    MembershipAuthorizationService,
    MembershipPolicyService,
    MembershipContributionCreditService,
    MembershipPaymentService,
    MembershipFulfillmentService,
    MEMBERSHIP_PAYMENT_REPOSITORY,
    MEMBERSHIP_PAYMENT_PROVIDER,
    MEMBERSHIP_FULFILLMENT_REPOSITORY,
    MEMBERSHIP_WEBHOOK_VERIFIER,
  ],
})
export class MembershipModule {}
