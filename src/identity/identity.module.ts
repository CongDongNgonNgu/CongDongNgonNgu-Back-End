import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { InMemoryIdentityRepository } from './identity.repository';
import { PostgresIdentityRepository } from './postgres-identity.repository';

export const IDENTITY_REPOSITORY = 'IDENTITY_REPOSITORY';

interface IdentityRuntimeConfig {
  persistence: 'postgres' | 'memory';
}

@Module({
  providers: [
    {
      provide: IDENTITY_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService): InMemoryIdentityRepository | PostgresIdentityRepository => {
        const auth = config.get<IdentityRuntimeConfig>('auth');
        if (auth?.persistence === 'memory') {
          return new InMemoryIdentityRepository();
        }
        const databaseUrl = config.get<string>('database.url');
        if (!databaseUrl) {
          throw new Error('DATABASE_URL is required for Postgres identity persistence');
        }
        return new PostgresIdentityRepository(new Pool({ connectionString: databaseUrl }));
      },
    },
  ],
  exports: [IDENTITY_REPOSITORY],
})
export class IdentityModule {}
