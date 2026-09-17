import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { AuthModule } from '../auth/auth.module';
import { IdentityModule } from '../identity/identity.module';
import { ProfileModule } from '../profile/profile.module';
import {
  EXCHANGE_PREFERENCE_REPOSITORY,
  InMemoryExchangePreferenceRepository,
} from './exchange.repository';
import { ExchangeController } from './exchange.controller';
import {
  EXCHANGE_SAFETY_GATE,
  ExchangeService,
  NoopExchangeSafetyGate,
} from './exchange.service';
import { PostgresExchangePreferenceRepository } from './postgres-exchange.repository';

interface ExchangeRuntimeConfig {
  persistence: 'postgres' | 'memory';
}

@Module({
  imports: [AuthModule, IdentityModule, ProfileModule],
  controllers: [ExchangeController],
  providers: [
    ExchangeService,
    {
      provide: EXCHANGE_SAFETY_GATE,
      useClass: NoopExchangeSafetyGate,
    },
    {
      provide: EXCHANGE_PREFERENCE_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const auth = config.get<ExchangeRuntimeConfig>('auth');
        if (auth?.persistence === 'memory') {
          return new InMemoryExchangePreferenceRepository();
        }
        const databaseUrl = config.get<string>('database.url');
        if (!databaseUrl) {
          throw new Error('DATABASE_URL is required for Postgres exchange persistence');
        }
        return new PostgresExchangePreferenceRepository(new Pool({ connectionString: databaseUrl }));
      },
    },
  ],
  exports: [EXCHANGE_PREFERENCE_REPOSITORY, ExchangeService],
})
export class ExchangeModule {}
