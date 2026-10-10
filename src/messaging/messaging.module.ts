import { Inject, Module, type MiddlewareConsumer, type NestModule, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { Request, Response, NextFunction } from 'express';
import { AuthModule } from '../auth/auth.module';
import { MessagingController } from './messaging.controller';
import { MessageCursorCodec } from './message-cursor';
import { PostgresDirectConversationRepository } from './postgres-direct-conversation.repository';
import { PostgresDirectMessageRepository } from './postgres-direct-message.repository';
import { PostgresMessageStreamRepository } from './postgres-message-stream.repository';
import { MessageStreamService } from './message-stream.service';

export const MESSAGING_POOL = 'MESSAGING_POOL';
@Module({
  imports: [AuthModule], controllers: [MessagingController],
  providers: [
    { provide: MESSAGING_POOL, inject: [ConfigService], useFactory: (config: ConfigService) => {
      const connectionString = config.get<string>('database.url');
      if (!connectionString) throw new Error('DATABASE_URL is required for direct messaging');
      // Same lazy PostgreSQL pattern as Study Groups; legacy memory-only startup
      // does not connect. Durable messaging always uses the authoritative database.
      return new Pool({ connectionString });
    } },
    { provide: MessageCursorCodec, inject: [ConfigService], useFactory: (config: ConfigService) => {
      const secret = config.get<string>('auth.accessSecret');
      if (!secret) throw new Error('Auth access secret is required for message cursors');
      return new MessageCursorCodec(secret);
    } },
    { provide: PostgresDirectConversationRepository, inject: [MESSAGING_POOL, MessageCursorCodec],
      useFactory: (pool: Pool, cursors: MessageCursorCodec) => new PostgresDirectConversationRepository(pool, cursors) },
    { provide: PostgresDirectMessageRepository, inject: [MESSAGING_POOL, PostgresDirectConversationRepository, MessageCursorCodec],
      useFactory: (pool: Pool, conversations: PostgresDirectConversationRepository, cursors: MessageCursorCodec) =>
        new PostgresDirectMessageRepository(pool, conversations, cursors) },
    { provide: PostgresMessageStreamRepository, inject: [MESSAGING_POOL, PostgresDirectConversationRepository],
      useFactory: (pool: Pool, conversations: PostgresDirectConversationRepository) => new PostgresMessageStreamRepository(pool, conversations) },
    { provide: MessageStreamService, inject: [PostgresMessageStreamRepository],
      useFactory: (repository: PostgresMessageStreamRepository) => new MessageStreamService(repository) },
  ],
})
export class MessagingModule implements NestModule, OnModuleDestroy {
  constructor(@Inject(MESSAGING_POOL) private readonly pool: Pool) {}
  configure(consumer: MiddlewareConsumer) {
    consumer.apply((_request: Request, response: Response, next: NextFunction) => {
      response.setHeader('Cache-Control', 'private, no-store');
      next();
    }).forRoutes(MessagingController);
  }
  async onModuleDestroy() { await this.pool.end(); }
}
