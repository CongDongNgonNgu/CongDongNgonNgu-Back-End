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
import {
  EXCHANGE_CONNECTION_REPOSITORY,
  InMemoryExchangeConnectionRepository,
} from './exchange-connection.repository';
import { NoopExchangeConnectionEventSink, EXCHANGE_CONNECTION_EVENT_SINK } from './exchange-connection.events';
import { ExchangeController } from './exchange.controller';
import {
  EXCHANGE_SAFETY_GATE,
  ExchangeService,
  NoopExchangeSafetyGate,
} from './exchange.service';
import { PostgresExchangePreferenceRepository } from './postgres-exchange.repository';
import { PostgresExchangeConnectionRepository } from './postgres-exchange-connection.repository';

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
    {
      provide: EXCHANGE_CONNECTION_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const auth = config.get<ExchangeRuntimeConfig>('auth');
        if (auth?.persistence === 'memory') {
          return new InMemoryExchangeConnectionRepository();
        }
        const databaseUrl = config.get<string>('database.url');
        if (!databaseUrl) {
          throw new Error('DATABASE_URL is required for Postgres exchange persistence');
        }
        return new PostgresExchangeConnectionRepository(new Pool({ connectionString: databaseUrl }));
      },
    },
    {
      provide: EXCHANGE_CONNECTION_EVENT_SINK,
      useClass: NoopExchangeConnectionEventSink,
    },
  ],
  exports: [EXCHANGE_PREFERENCE_REPOSITORY, EXCHANGE_CONNECTION_REPOSITORY, ExchangeService],
})
export class ExchangeModule {}
