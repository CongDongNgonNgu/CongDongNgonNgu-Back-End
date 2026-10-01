import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { AuthModule } from '../auth/auth.module';
import { ReputationModule } from '../reputation/reputation.module';
import {
  InMemoryMembershipRepository,
  MEMBERSHIP_REPOSITORY,
  PostgresMembershipRepository,
} from './membership.repository';
import { MembershipController } from './membership.controller';
import { MembershipContributionCreditService } from './membership.contribution-credit';
import {
  createDisabledMembershipPaymentProvider,
  MEMBERSHIP_PAYMENT_PROVIDER,
} from './membership.payment-provider';
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
  imports: [AuthModule, ReputationModule],
  controllers: [MembershipController],
  providers: [
    MembershipAuthorizationService,
    MembershipPolicyService,
    MembershipContributionCreditService,
    MembershipPaymentService,
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
        return createDisabledMembershipPaymentProvider(providers?.payment === 'configured');
      },
    },
  ],
  exports: [
    MEMBERSHIP_REPOSITORY,
    MembershipAuthorizationService,
    MembershipPolicyService,
    MembershipContributionCreditService,
    MembershipPaymentService,
    MEMBERSHIP_PAYMENT_REPOSITORY,
    MEMBERSHIP_PAYMENT_PROVIDER,
  ],
})
export class MembershipModule {}
