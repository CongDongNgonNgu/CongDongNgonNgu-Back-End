import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, type AuthenticatedRequest } from '../auth/guards/access-token.guard';
import { SessionService } from '../auth/session/session.service';
import { success } from '../common/http/api-response';
import { AiCoachingService } from './ai.coaching.service';
import { AiGrammarCoachDto, AiWritingCoachDto } from './ai.coaching.dto';

@Controller('ai/coaching')
@UseGuards(AccessTokenGuard)
export class AiCoachingController {
  constructor(
    private readonly coaching: AiCoachingService,
    private readonly sessions: SessionService,
  ) {}

  @Post('writing')
  async writing(@Body() input: AiWritingCoachDto, @Req() request: AuthenticatedRequest) {
    this.sessions.assertCsrfForCookie(request);
    return success(await this.coaching.write(request.user!.user.id, input), 'AI writing coaching');
  }

  @Post('grammar')
  async grammar(@Body() input: AiGrammarCoachDto, @Req() request: AuthenticatedRequest) {
    this.sessions.assertCsrfForCookie(request);
    return success(await this.coaching.grammar(request.user!.user.id, input), 'AI grammar coaching');
  }
}
