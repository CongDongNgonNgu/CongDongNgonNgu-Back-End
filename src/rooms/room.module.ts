import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { AuthModule } from '../auth/auth.module';
import { IdentityModule } from '../identity/identity.module';
import { ProfileModule } from '../profile/profile.module';
import { DisabledMediaProvider, SPEAKING_ROOM_MEDIA_PROVIDER } from './media-provider';
import { InMemorySpeakingRoomRepository, SPEAKING_ROOM_REPOSITORY } from './room.repository';
import {
  InMemorySpeakingRoomParticipantRepository,
  SPEAKING_ROOM_PARTICIPANT_REPOSITORY,
} from './room.participant.repository';
import { SpeakingRoomController } from './room.controller';
import { SpeakingRoomService } from './room.service';
import { PostgresSpeakingRoomRepository } from './postgres-room.repository';
import { PostgresSpeakingRoomParticipantRepository } from './postgres-room-participant.repository';

interface RoomRuntimeConfig {
  persistence: 'postgres' | 'memory';
}

@Module({
  imports: [AuthModule, IdentityModule, ProfileModule],
  controllers: [SpeakingRoomController],
  providers: [
    SpeakingRoomService,
    {
      provide: SPEAKING_ROOM_MEDIA_PROVIDER,
      useFactory: () => new DisabledMediaProvider(),
    },
    {
      provide: SPEAKING_ROOM_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const auth = config.get<RoomRuntimeConfig>('auth');
        if (auth?.persistence === 'memory') return new InMemorySpeakingRoomRepository();
        const databaseUrl = config.get<string>('database.url');
        if (!databaseUrl) {
          throw new Error('DATABASE_URL is required for Postgres speaking-room persistence');
        }
        return new PostgresSpeakingRoomRepository(new Pool({ connectionString: databaseUrl }));
      },
    },
    {
      provide: SPEAKING_ROOM_PARTICIPANT_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const auth = config.get<RoomRuntimeConfig>('auth');
        if (auth?.persistence === 'memory') return new InMemorySpeakingRoomParticipantRepository();
        const databaseUrl = config.get<string>('database.url');
        if (!databaseUrl) {
          throw new Error('DATABASE_URL is required for Postgres speaking-room participant persistence');
        }
        return new PostgresSpeakingRoomParticipantRepository(new Pool({ connectionString: databaseUrl }));
      },
    },
  ],
  exports: [
    SPEAKING_ROOM_REPOSITORY,
    SPEAKING_ROOM_PARTICIPANT_REPOSITORY,
    SPEAKING_ROOM_MEDIA_PROVIDER,
    SpeakingRoomService,
  ],
})
export class SpeakingRoomModule {}
