import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { AuthModule } from '../auth/auth.module';
import { IdentityModule } from '../identity/identity.module';
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
  imports: [AuthModule, IdentityModule],
  controllers: [NotificationController],
  providers: [
    NotificationService,
    NotificationRealtimeService,
    NotificationPreferenceService,
    NotificationDomainEventIntegrationService,
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
  ],
})
export class NotificationModule {}
