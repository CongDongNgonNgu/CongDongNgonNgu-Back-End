import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { AuthModule } from '../auth/auth.module';
import { CommunityModule } from '../community/community.module';
import { IdentityModule } from '../identity/identity.module';
import { LibraryModule } from '../library/library.module';
import { ReputationModule } from '../reputation/reputation.module';
import { AdminController } from './admin.controller';
import { ADMIN_AUDIT_REPOSITORY, InMemoryAdminAuditRepository, PostgresAdminAuditRepository } from './admin-audit.repository';
import { AdminModerationActionService } from './admin-moderation-action.service';
import { AdminService } from './admin.service';

interface AdminRuntimeConfig {
  persistence: 'postgres' | 'memory';
}

@Module({
  imports: [AuthModule, CommunityModule, IdentityModule, LibraryModule, ReputationModule],
  controllers: [AdminController],
  providers: [
    AdminService,
    AdminModerationActionService,
    {
      provide: ADMIN_AUDIT_REPOSITORY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const auth = config.get<AdminRuntimeConfig>('auth');
        if (auth?.persistence === 'memory') return new InMemoryAdminAuditRepository();
        const databaseUrl = config.get<string>('database.url');
        if (!databaseUrl) {
          throw new Error('DATABASE_URL is required for Postgres admin audit persistence');
        }
        return new PostgresAdminAuditRepository(new Pool({ connectionString: databaseUrl }));
      },
    },
  ],
  exports: [AdminService, ADMIN_AUDIT_REPOSITORY],
})
export class AdminModule {}
