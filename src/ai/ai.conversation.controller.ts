import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, type AuthenticatedRequest } from '../auth/guards/access-token.guard';
import { SessionService } from '../auth/session/session.service';
import { success } from '../common/http/api-response';
import { CreateAiConversationDto, CreateAiConversationTurnDto, ExplainAiConversationDto } from './ai.conversation.dto';
import { AiConversationService } from './ai.conversation.service';

@Controller('ai/conversations')
@UseGuards(AccessTokenGuard)
export class AiConversationController {
  constructor(private readonly conversations: AiConversationService, private readonly sessions: SessionService) {}

  @Post()
  async create(@Body() input: CreateAiConversationDto, @Req() request: AuthenticatedRequest) {
    this.sessions.assertCsrfForCookie(request);
    return success(await this.conversations.create(request.user!.user.id, input), 'AI conversation created');
  }

  @Get(':conversationId')
  async get(@Param('conversationId') conversationId: string, @Req() request: AuthenticatedRequest) {
    return success(await this.conversations.get(request.user!.user.id, conversationId), 'AI conversation');
  }

  @Post(':conversationId/turns')
  async sendTurn(@Param('conversationId') conversationId: string, @Body() input: CreateAiConversationTurnDto, @Req() request: AuthenticatedRequest) {
    this.sessions.assertCsrfForCookie(request);
    return success(await this.conversations.sendTurn(request.user!.user.id, conversationId, input), 'AI conversation turn');
  }

  @Post(':conversationId/explain')
  async explain(@Param('conversationId') conversationId: string, @Body() input: ExplainAiConversationDto, @Req() request: AuthenticatedRequest) {
    this.sessions.assertCsrfForCookie(request);
    return success(await this.conversations.explain(request.user!.user.id, conversationId, input), 'AI conversation explanation');
  }

  @Post(':conversationId/stop')
  async stop(@Param('conversationId') conversationId: string, @Req() request: AuthenticatedRequest) {
    this.sessions.assertCsrfForCookie(request);
    return success(await this.conversations.stop(request.user!.user.id, conversationId), 'AI conversation stopped');
  }
}
