import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { AuthModule } from '../auth/auth.module';
import { IdentityModule } from '../identity/identity.module';
import { ProfileModule } from '../profile/profile.module';
import { CommunityController } from './community.controller';
import { CommunityRateLimiter } from './community.rate-limiter';
import { COMMUNITY_REPOSITORY } from './community.repository';
import { InMemoryCommunityRepository } from './community.repository';
import { CommunityService } from './community.service';
import { OptionalAccessTokenGuard } from './optional-access-token.guard';
import { PostgresCommunityRepository } from './postgres-community.repository';

interface CommunityRuntimeConfig {
  persistence: 'postgres' | 'memory';
}

@Module({
  imports: [AuthModule, IdentityModule, ProfileModule],
  controllers: [CommunityController],
  providers: [
    CommunityService,
    CommunityRateLimiter,
    OptionalAccessTokenGuard,
    {
      provide: COMMUNITY_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const auth = config.get<CommunityRuntimeConfig>('auth');
        if (auth?.persistence === 'memory') return new InMemoryCommunityRepository();
        const databaseUrl = config.get<string>('database.url');
        if (!databaseUrl) {
          throw new Error('DATABASE_URL is required for Postgres community persistence');
        }
        return new PostgresCommunityRepository(new Pool({ connectionString: databaseUrl }));
      },
    },
  ],
  exports: [COMMUNITY_REPOSITORY, CommunityService],
})
export class CommunityModule {}
