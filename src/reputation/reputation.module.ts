import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { AuthModule } from '../auth/auth.module';
import { ProfileModule } from '../profile/profile.module';
import { LearningProgressController } from './learning-progress.controller';
import { ReputationProgressController } from './reputation-progress.controller';
import { LearningXpRuleEngine } from './learning-xp.rules';
import { LearningXpService } from './learning-xp.service';
import { GamificationService } from './gamification.service';
import { AntiFarmingRuleEngine } from './anti-farming.rules';
import { ContributionRuleEngine } from './reputation.rules';
import {
  InMemoryReputationLedgerRepository,
  PostgresReputationLedgerRepository,
  REPUTATION_LEDGER_REPOSITORY,
} from './reputation.repository';
import { REPUTATION_SERVICE, ReputationService } from './reputation.service';

interface ReputationRuntimeConfig {
  persistence: 'postgres' | 'memory';
}

@Module({
  imports: [AuthModule, ProfileModule],
  controllers: [LearningProgressController, ReputationProgressController],
  providers: [
    {
      provide: LearningXpRuleEngine,
      useFactory: () => new LearningXpRuleEngine(),
    },
    {
      provide: ContributionRuleEngine,
      useFactory: () => new ContributionRuleEngine(),
    },
    ReputationService,
    LearningXpService,
    GamificationService,
    AntiFarmingRuleEngine,
    {
      provide: REPUTATION_LEDGER_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const auth = config.get<ReputationRuntimeConfig>('auth');
        if (auth?.persistence === 'memory') return new InMemoryReputationLedgerRepository();
        const databaseUrl = config.get<string>('database.url');
        if (!databaseUrl) {
          throw new Error('DATABASE_URL is required for Postgres reputation persistence');
        }
        return new PostgresReputationLedgerRepository(new Pool({ connectionString: databaseUrl }));
      },
    },
    {
      provide: REPUTATION_SERVICE,
      useExisting: ReputationService,
    },
  ],
  exports: [
    REPUTATION_LEDGER_REPOSITORY,
    REPUTATION_SERVICE,
    ReputationService,
    LearningXpService,
    GamificationService,
  ],
})
export class ReputationModule {}
