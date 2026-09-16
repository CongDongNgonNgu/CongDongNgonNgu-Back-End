import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { AuthModule } from '../auth/auth.module';
import { CommunityModule } from '../community/community.module';
import { COMMUNITY_REPOSITORY } from '../community/community.repository';
import type { CommunityRepository } from '../community/community.repository';
import { IdentityModule } from '../identity/identity.module';
import { ProfileModule } from '../profile/profile.module';
import { CorrectionsController } from './corrections.controller';
import { CORRECTIONS_REPOSITORY } from './corrections.repository';
import { InMemoryCorrectionsRepository } from './corrections.repository';
import { CorrectionsService } from './corrections.service';
import { PostgresCorrectionsRepository } from './postgres-corrections.repository';

interface CorrectionsRuntimeConfig {
  persistence: 'postgres' | 'memory';
}

@Module({
  imports: [AuthModule, CommunityModule, IdentityModule, ProfileModule],
  controllers: [CorrectionsController],
  providers: [
    CorrectionsService,
    {
      provide: CORRECTIONS_REPOSITORY,
      inject: [ConfigService, COMMUNITY_REPOSITORY],
      useFactory: (
        config: ConfigService,
        community: CommunityRepository,
      ) => {
        const auth = config.get<CorrectionsRuntimeConfig>('auth');
        if (auth?.persistence === 'memory') {
          return new InMemoryCorrectionsRepository(community);
        }
        const databaseUrl = config.get<string>('database.url');
        if (!databaseUrl) {
          throw new Error('DATABASE_URL is required for Postgres corrections persistence');
        }
        return new PostgresCorrectionsRepository(new Pool({ connectionString: databaseUrl }));
      },
    },
  ],
  exports: [CorrectionsService, CORRECTIONS_REPOSITORY],
})
export class CorrectionsModule {}
