import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { AuthModule } from '../auth/auth.module';
import { OptionalAccessTokenGuard } from '../community/optional-access-token.guard';
import { IdentityModule } from '../identity/identity.module';
import { ProfileModule } from '../profile/profile.module';
import { NotificationModule } from '../notifications/notification.module';
import { SpeakingRoomModule } from '../rooms/room.module';
import { EventController } from './event.controller';
import { EVENT_REPOSITORY, InMemoryEventRepository } from './event.repository';
import {
  EVENT_PARTICIPATION_REPOSITORY,
  InMemoryEventParticipationRepository,
} from './event.participation.repository';
import { EventService } from './event.service';
import { PostgresEventRepository } from './postgres-event.repository';
import { PostgresEventParticipationRepository } from './postgres-event-participation.repository';
import {
  EVENT_ATTENDANCE_LEARNING_HOOK,
  NoopEventAttendanceLearningHook,
} from './event.participation.types';

interface EventRuntimeConfig {
  persistence: 'postgres' | 'memory';
}

@Module({
  imports: [
    AuthModule,
    IdentityModule,
    ProfileModule,
    NotificationModule,
    SpeakingRoomModule,
  ],
  controllers: [EventController],
  providers: [
    EventService,
    {
      provide: EVENT_ATTENDANCE_LEARNING_HOOK,
      useFactory: () => new NoopEventAttendanceLearningHook(),
    },
    OptionalAccessTokenGuard,
    {
      provide: EVENT_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const auth = config.get<EventRuntimeConfig>('auth');
        if (auth?.persistence === 'memory')
          return new InMemoryEventRepository();
        const databaseUrl = config.get<string>('database.url');
        if (!databaseUrl)
          throw new Error(
            'DATABASE_URL is required for Postgres event persistence',
          );
        return new PostgresEventRepository(
          new Pool({ connectionString: databaseUrl }),
        );
      },
    },
    {
      provide: EVENT_PARTICIPATION_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const auth = config.get<EventRuntimeConfig>('auth');
        if (auth?.persistence === 'memory') {
          return new InMemoryEventParticipationRepository();
        }
        const databaseUrl = config.get<string>('database.url');
        if (!databaseUrl) {
          throw new Error(
            'DATABASE_URL is required for Postgres event participation persistence',
          );
        }
        return new PostgresEventParticipationRepository(
          new Pool({ connectionString: databaseUrl }),
        );
      },
    },
  ],
  exports: [
    EVENT_REPOSITORY,
    EVENT_PARTICIPATION_REPOSITORY,
    EVENT_ATTENDANCE_LEARNING_HOOK,
    EventService,
  ],
})
export class EventModule {}
