import { LearningContextModule } from '../communication/learning-context.module';
import { MessageContextResolver } from '../communication/learning-context-resolver';
import { GroupSyncCursor } from './group-sync-cursor';
import { GroupStreamService } from './group-stream.service';
import { PostgresGroupStreamRepository } from './postgres-group-stream.repository';
import {
  Inject,
  Module,
  type MiddlewareConsumer,
  type NestModule,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { Request, Response, NextFunction } from 'express';
import { AuthModule } from '../auth/auth.module';
import { StudyGroupController } from './study-group.controller';
import { StudyGroupService } from './study-group.service';
export const STUDY_GROUP_POOL = 'STUDY_GROUP_POOL';
@Module({
  imports: [AuthModule, LearningContextModule],
  controllers: [StudyGroupController],
  providers: [
    {
      provide: GroupSyncCursor,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new GroupSyncCursor(config.get<string>('auth.accessSecret') ?? ''),
    },
    {
      provide: PostgresGroupStreamRepository,
      inject: [STUDY_GROUP_POOL],
      useFactory: (pool: Pool) => new PostgresGroupStreamRepository(pool),
    },
    {
      provide: GroupStreamService,
      inject: [PostgresGroupStreamRepository],
      useFactory: (repository: PostgresGroupStreamRepository) =>
        new GroupStreamService(repository),
    },
    {
      provide: STUDY_GROUP_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const connectionString = config.get<string>('database.url');
        if (!connectionString)
          throw new Error('DATABASE_URL is required for study groups');
        // Pool is lazy; legacy memory-only test startup makes no group SQL connection.
        return new Pool({ connectionString });
      },
    },
    {
      provide: StudyGroupService,
      inject: [STUDY_GROUP_POOL, MessageContextResolver, GroupSyncCursor],
      useFactory: (
        pool: Pool,
        contexts: MessageContextResolver,
        cursors: GroupSyncCursor,
      ) => new StudyGroupService(pool, contexts, cursors),
    },
  ],
  exports: [StudyGroupService],
})
export class StudyGroupModule implements NestModule, OnModuleDestroy {
  constructor(@Inject(STUDY_GROUP_POOL) private readonly pool: Pool) {}
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply((_request: Request, response: Response, next: NextFunction) => {
        response.setHeader('Cache-Control', 'private, no-store');
        next();
      })
      .forRoutes(StudyGroupController);
  }
  async onModuleDestroy() {
    await this.pool.end();
  }
}
