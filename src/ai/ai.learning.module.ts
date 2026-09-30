import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LibraryModule } from '../library/library.module';
import { ProfileModule } from '../profile/profile.module';
import { AiModule } from './ai.module';
import { AiLearningController } from './ai.learning.controller';
import { AiLearningService } from './ai.learning.service';

@Module({
  imports: [AuthModule, LibraryModule, ProfileModule, AiModule],
  controllers: [AiLearningController],
  providers: [AiLearningService],
  exports: [AiLearningService],
})
export class AiLearningModule {}
