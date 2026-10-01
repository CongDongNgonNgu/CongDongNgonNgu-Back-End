import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { AuthModule } from '../auth/auth.module';
import { IdentityModule } from '../identity/identity.module';
import { ProfileModule } from '../profile/profile.module';
import { ChallengeRuleEngine } from './challenge.rules';
import { CHALLENGE_REPOSITORY, InMemoryChallengeRepository } from './challenge.repository';
import { PostgresChallengeRepository } from './postgres-challenge.repository';
import { ChallengeService } from './challenge.service';

interface ChallengeRuntimeConfig {
  persistence: 'postgres' | 'memory';
}

@Module({
  imports: [AuthModule, IdentityModule, ProfileModule],
  providers: [
    ChallengeRuleEngine,
    ChallengeService,
    {
      provide: CHALLENGE_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const auth = config.get<ChallengeRuntimeConfig>('auth');
        if (auth?.persistence === 'memory') return new InMemoryChallengeRepository();
        const databaseUrl = config.get<string>('database.url');
        if (!databaseUrl) {
          throw new Error('DATABASE_URL is required for Postgres challenge persistence');
        }
        return new PostgresChallengeRepository(new Pool({ connectionString: databaseUrl }));
      },
    },
  ],
  exports: [CHALLENGE_REPOSITORY, ChallengeRuleEngine, ChallengeService],
})
export class ChallengeModule {}
