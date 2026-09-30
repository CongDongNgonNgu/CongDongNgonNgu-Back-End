import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProfileModule } from '../profile/profile.module';
import { AiModule } from './ai.module';
import { AiConversationController } from './ai.conversation.controller';
import { AiConversationService } from './ai.conversation.service';
import { AI_CONVERSATION_REPOSITORY, InMemoryAiConversationRepository } from './ai.conversation.repository';

@Module({
  imports: [AuthModule, ProfileModule, AiModule],
  controllers: [AiConversationController],
  providers: [
    AiConversationService,
    { provide: AI_CONVERSATION_REPOSITORY, useFactory: () => new InMemoryAiConversationRepository() },
  ],
  exports: [AiConversationService],
})
export class AiConversationModule {}
