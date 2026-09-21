import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { AuthModule } from '../auth/auth.module';
import { ProfileModule } from '../profile/profile.module';
import { LibraryController } from './library.controller';
import { LIBRARY_REPOSITORY } from './library.repository';
import { InMemoryLibraryRepository } from './library.repository';
import { LibraryService } from './library.service';
import { PostgresLibraryRepository } from './postgres-library.repository';

interface LibraryRuntimeConfig {
  persistence: 'postgres' | 'memory';
}

@Module({
  imports: [AuthModule, ProfileModule],
  controllers: [LibraryController],
  providers: [
    LibraryService,
    {
      provide: LIBRARY_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const auth = config.get<LibraryRuntimeConfig>('auth');
        if (auth?.persistence === 'memory') return new InMemoryLibraryRepository();
        const databaseUrl = config.get<string>('database.url');
        if (!databaseUrl) {
          throw new Error('DATABASE_URL is required for Postgres library persistence');
        }
        return new PostgresLibraryRepository(new Pool({ connectionString: databaseUrl }));
      },
    },
  ],
  exports: [LibraryService, LIBRARY_REPOSITORY],
})
export class LibraryModule {}
