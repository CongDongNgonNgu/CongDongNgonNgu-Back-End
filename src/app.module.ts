import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { AppConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { ProfileModule } from './profile/profile.module';
import { CommunityModule } from './community/community.module';
import { CorrectionsModule } from './corrections/corrections.module';
import { ExchangeModule } from './exchange/exchange.module';
import { LibraryModule } from './library/library.module';
import { AiModule } from './ai/ai.module';
import { AiConversationModule } from './ai/ai.conversation.module';

@Module({
  imports: [
    AppConfigModule,
    HealthModule,
    AuthModule,
    ProfileModule,
    CommunityModule,
    CorrectionsModule,
    ExchangeModule,
    LibraryModule,
    AiModule,
    AiConversationModule,
  ],
})
export class AppModule {}
