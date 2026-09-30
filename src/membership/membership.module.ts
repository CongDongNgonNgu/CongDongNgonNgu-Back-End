import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { AuthModule } from '../auth/auth.module';
import {
  InMemoryMembershipRepository,
  MEMBERSHIP_REPOSITORY,
  PostgresMembershipRepository,
} from './membership.repository';
import { MembershipController } from './membership.controller';
import { MembershipAuthorizationService } from './membership.service';

interface MembershipRuntimeConfig {
  persistence: 'postgres' | 'memory';
}

@Module({
  imports: [AuthModule],
  controllers: [MembershipController],
  providers: [
    MembershipAuthorizationService,
    {
      provide: MEMBERSHIP_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const auth = config.get<MembershipRuntimeConfig>('auth');
        if (auth?.persistence === 'memory') return new InMemoryMembershipRepository();
        const databaseUrl = config.get<string>('database.url');
        if (!databaseUrl) {
          throw new Error('DATABASE_URL is required for Postgres membership persistence');
        }
        return new PostgresMembershipRepository(new Pool({ connectionString: databaseUrl }));
      },
    },
  ],
  exports: [MEMBERSHIP_REPOSITORY, MembershipAuthorizationService],
})
export class MembershipModule {}
