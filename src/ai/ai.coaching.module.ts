import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProfileModule } from '../profile/profile.module';
import { AiModule } from './ai.module';
import { AiCoachingController } from './ai.coaching.controller';
import { AiCoachingService } from './ai.coaching.service';

@Module({
  imports: [AuthModule, ProfileModule, AiModule],
  controllers: [AiCoachingController],
  providers: [AiCoachingService],
  exports: [AiCoachingService],
})
export class AiCoachingModule {}
