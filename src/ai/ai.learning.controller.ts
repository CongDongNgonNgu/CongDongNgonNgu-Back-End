import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, type AuthenticatedRequest } from '../auth/guards/access-token.guard';
import { SessionService } from '../auth/session/session.service';
import { success } from '../common/http/api-response';
import { AiLearningDto } from './ai.learning.dto';
import { AiLearningService } from './ai.learning.service';

@Controller('ai/learning')
@UseGuards(AccessTokenGuard)
export class AiLearningController {
  constructor(
    private readonly learning: AiLearningService,
    private readonly sessions: SessionService,
  ) {}

  @Post('library')
  async library(@Body() input: AiLearningDto, @Req() request: AuthenticatedRequest) {
    this.sessions.assertCsrfForCookie(request);
    return success(await this.learning.learn(request.user!.user.id, input), 'AI library learning');
  }
}
