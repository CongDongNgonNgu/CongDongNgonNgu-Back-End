import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, type AuthenticatedRequest } from '../auth/guards/access-token.guard';
import { success } from '../common/http/api-response';
import { LearningXpService } from './learning-xp.service';

@Controller('learning')
export class LearningProgressController {
  constructor(private readonly learning: LearningXpService) {}

  @Get('progress')
  @UseGuards(AccessTokenGuard)
  async progress(@Req() request: AuthenticatedRequest) {
    return success(
      await this.learning.getProgress(request.user!.user.id),
      'Learning progress',
    );
  }
}
