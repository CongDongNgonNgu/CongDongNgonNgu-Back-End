import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { AuthModule } from '../auth/auth.module';
import { OptionalAccessTokenGuard } from '../community/optional-access-token.guard';
import { IdentityModule } from '../identity/identity.module';
import { ProfileModule } from '../profile/profile.module';
import { SpeakingRoomModule } from '../rooms/room.module';
import { EventController } from './event.controller';
import { EVENT_REPOSITORY, InMemoryEventRepository } from './event.repository';
import { EventService } from './event.service';
import { PostgresEventRepository } from './postgres-event.repository';

interface EventRuntimeConfig {
  persistence: 'postgres' | 'memory';
}

@Module({
  imports: [AuthModule, IdentityModule, ProfileModule, SpeakingRoomModule],
  controllers: [EventController],
  providers: [
    EventService,
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
  ],
  exports: [EVENT_REPOSITORY, EventService],
})
export class EventModule {}
