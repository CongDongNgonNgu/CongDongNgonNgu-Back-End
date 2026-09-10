import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { AuthModule } from '../auth/auth.module';
import { IdentityModule } from '../identity/identity.module';
import { InMemoryProfileRepository } from './profile.repository';
import { PostgresProfileRepository } from './postgres-profile.repository';
import { PROFILE_REPOSITORY } from './profile.repository';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';

interface ProfileRuntimeConfig {
  persistence: 'postgres' | 'memory';
}

@Module({
  imports: [AuthModule, IdentityModule],
  controllers: [ProfileController],
  providers: [
    ProfileService,
    {
      provide: PROFILE_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const auth = config.get<ProfileRuntimeConfig>('auth');
        if (auth?.persistence === 'memory') {
          return new InMemoryProfileRepository();
        }
        const databaseUrl = config.get<string>('database.url');
        if (!databaseUrl) {
          throw new Error('DATABASE_URL is required for Postgres profile persistence');
        }
        return new PostgresProfileRepository(new Pool({ connectionString: databaseUrl }));
      },
    },
  ],
  exports: [PROFILE_REPOSITORY, ProfileService],
})
export class ProfileModule {}
