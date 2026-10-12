import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { AuthModule } from '../auth/auth.module';
import { IdentityModule } from '../identity/identity.module';
import { IDENTITY_REPOSITORY } from '../identity/identity.module';
import type { IdentityRepository } from '../identity/identity.repository';
import { ProfileModule } from '../profile/profile.module';
import { PROFILE_REPOSITORY,type ProfileRepository } from '../profile/profile.repository';
import { ExchangePersistenceModule } from '../exchange/exchange-persistence.module';
import { EXCHANGE_PREFERENCE_REPOSITORY,type ExchangePreferenceRepository } from '../exchange/exchange.repository';
import { EXCHANGE_CONNECTION_REPOSITORY,InMemoryExchangeConnectionRepository } from '../exchange/exchange-connection.repository';
import { CONNECTION_NOTIFICATION_ACCESS } from './connection-notification-access';
import { MemoryConnectionNotificationAccess } from './memory-connection-notification-access';
import { PostgresConnectionNotificationAccess } from './postgres-connection-notification-access';
import { DirectMessageNotificationWorker } from '../messaging/direct-message-notification-worker';
import { PostgresDirectConversationRepository } from '../messaging/postgres-direct-conversation.repository';
import { NotificationController } from './notification.controller';
import { NOTIFICATION_REPOSITORY, InMemoryNotificationRepository } from './notification.repository';
import { NotificationService } from './notification.service';
import { PostgresNotificationRepository } from './postgres-notification.repository';
import { NotificationRealtimeService } from './notification-realtime.service';
import {
  NOTIFICATION_PREFERENCE_REPOSITORY,
  InMemoryNotificationPreferenceRepository,
} from './notification-preference.repository';
import { NotificationPreferenceService } from './notification-preference.service';
import { PostgresNotificationPreferenceRepository } from './postgres-notification-preference.repository';
import {
  NOTIFICATION_DOMAIN_EVENT_SINK,
  NotificationDomainEventIntegrationService,
} from './notification-event-integration';

interface NotificationRuntimeConfig {
  persistence: 'postgres' | 'memory';
}

@Module({
  imports: [AuthModule, IdentityModule,ProfileModule,ExchangePersistenceModule],
  controllers: [NotificationController],
  providers: [
    NotificationService,
    NotificationRealtimeService,
    NotificationPreferenceService,
    NotificationDomainEventIntegrationService,
    {
      provide: DirectMessageNotificationWorker,
      inject: [ConfigService, NOTIFICATION_REPOSITORY, NotificationRealtimeService],
      useFactory: (config: ConfigService, repository: InMemoryNotificationRepository | PostgresNotificationRepository,
        realtime: NotificationRealtimeService) => {
        // Durable messaging has no memory producer. Avoid starting a PostgreSQL
        // poller in legacy memory-only applications and test environments.
        if (config.get<NotificationRuntimeConfig>('auth')?.persistence === 'memory') return null;
        if (!(repository instanceof PostgresNotificationRepository)) throw new Error('Direct-message notices require PostgreSQL persistence');
        const connectionString = config.get<string>('database.url');
        if (!connectionString) throw new Error('DATABASE_URL is required for direct-message notifications');
        const pool = new Pool({ connectionString });
        // Construct the neutral persistence adapter here: importing MessagingModule
        // would cycle through CommunityModule back to NotificationModule.
        return new DirectMessageNotificationWorker(pool, new PostgresDirectConversationRepository(pool), repository, realtime, true);
      },
    },
    {provide:CONNECTION_NOTIFICATION_ACCESS,
      inject:[ConfigService,IDENTITY_REPOSITORY,PROFILE_REPOSITORY,EXCHANGE_PREFERENCE_REPOSITORY,EXCHANGE_CONNECTION_REPOSITORY,NotificationPreferenceService],
      useFactory:(config:ConfigService,identities:IdentityRepository,profiles:ProfileRepository,preferences:ExchangePreferenceRepository,
        connections:InMemoryExchangeConnectionRepository,notificationPreferences:NotificationPreferenceService)=>{
        if(config.get<NotificationRuntimeConfig>('auth')?.persistence==='memory') {
          if(!(connections instanceof InMemoryExchangeConnectionRepository)) throw new Error('Memory connection access requires shared memory persistence');
          return new MemoryConnectionNotificationAccess(identities,profiles,preferences,connections,notificationPreferences);
        }
        const connectionString=config.get<string>('database.url');
        if(!connectionString) throw new Error('DATABASE_URL is required for current notification access');
        return new PostgresConnectionNotificationAccess(new Pool({connectionString}));
      }},
    {
      provide: NOTIFICATION_DOMAIN_EVENT_SINK,
      useExisting: NotificationDomainEventIntegrationService,
    },
    {
      provide: NOTIFICATION_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const auth = config.get<NotificationRuntimeConfig>('auth');
        if (auth?.persistence === 'memory') return new InMemoryNotificationRepository();
        const databaseUrl = config.get<string>('database.url');
        if (!databaseUrl) {
          throw new Error('DATABASE_URL is required for Postgres notification persistence');
        }
        return new PostgresNotificationRepository(new Pool({ connectionString: databaseUrl }));
      },
    },
    {
      provide: NOTIFICATION_PREFERENCE_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const auth = config.get<NotificationRuntimeConfig>('auth');
        if (auth?.persistence === 'memory') return new InMemoryNotificationPreferenceRepository();
        const databaseUrl = config.get<string>('database.url');
        if (!databaseUrl) {
          throw new Error('DATABASE_URL is required for Postgres notification preference persistence');
        }
        return new PostgresNotificationPreferenceRepository(new Pool({ connectionString: databaseUrl }));
      },
    },
  ],
  exports: [
    NOTIFICATION_REPOSITORY,
    NotificationService,
    NotificationRealtimeService,
    NOTIFICATION_DOMAIN_EVENT_SINK,
    NOTIFICATION_PREFERENCE_REPOSITORY,
    NotificationPreferenceService,
    CONNECTION_NOTIFICATION_ACCESS,
  ],
})
export class NotificationModule {}
