import { Module } from '@nestjs/common';
import { StudyGroupModule } from './study-groups/study-group.module';
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
import { AiCoachingModule } from './ai/ai.coaching.module';
import { AiLearningModule } from './ai/ai.learning.module';
import { ReputationModule } from './reputation/reputation.module';
import { MembershipModule } from './membership/membership.module';
import { NotificationModule } from './notifications/notification.module';
import { SpeakingRoomModule } from './rooms/room.module';
import { ChallengeModule } from './challenges/challenge.module';
import { EventModule } from './events/event.module';
import { AdminModule } from './admin/admin.module';

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
    AiCoachingModule,
    AiLearningModule,
    ReputationModule,
    MembershipModule,
    NotificationModule,
    SpeakingRoomModule,
    ChallengeModule,
    EventModule,
    AdminModule,
    StudyGroupModule,
  ],
})
export class AppModule {}
