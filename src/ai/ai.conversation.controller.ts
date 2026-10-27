import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, type AuthenticatedRequest } from '../auth/guards/access-token.guard';
import { SessionService } from '../auth/session/session.service';
import { success } from '../common/http/api-response';
import { CreateAiConversationDto, CreateAiConversationTurnDto, ExplainAiConversationDto } from './ai.conversation.dto';
import { AiConversationService } from './ai.conversation.service';

@ApiTags("AI")
@ApiResponse({ status: 400, description: 'Request validation failed', schema: { $ref: '#/components/schemas/ApiError' } })
@ApiBearerAuth('bearer')
@ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
@Controller('ai/conversations')
@UseGuards(AccessTokenGuard)
export class AiConversationController {
  constructor(private readonly conversations: AiConversationService, private readonly sessions: SessionService) {}

  @ApiOperation({ summary: "Create - AI" })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post()
  async create(@Body() input: CreateAiConversationDto, @Req() request: AuthenticatedRequest) {
    this.sessions.assertCsrfForCookie(request);
    return success(await this.conversations.create(request.user!.user.id, input), 'AI conversation created');
  }

  @ApiOperation({ summary: "Get - AI" })
  @ApiParam({ name: "conversationId", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get(':conversationId')
  async get(@Param('conversationId') conversationId: string, @Req() request: AuthenticatedRequest) {
    return success(await this.conversations.get(request.user!.user.id, conversationId), 'AI conversation');
  }

  @ApiOperation({ summary: "Send Turn - AI" })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "conversationId", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post(':conversationId/turns')
  async sendTurn(@Param('conversationId') conversationId: string, @Body() input: CreateAiConversationTurnDto, @Req() request: AuthenticatedRequest) {
    this.sessions.assertCsrfForCookie(request);
    return success(await this.conversations.sendTurn(request.user!.user.id, conversationId, input), 'AI conversation turn');
  }

  @ApiOperation({ summary: "Explain - AI" })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "conversationId", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post(':conversationId/explain')
  async explain(@Param('conversationId') conversationId: string, @Body() input: ExplainAiConversationDto, @Req() request: AuthenticatedRequest) {
    this.sessions.assertCsrfForCookie(request);
    return success(await this.conversations.explain(request.user!.user.id, conversationId, input), 'AI conversation explanation');
  }

  @ApiOperation({ summary: "Stop - AI" })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "conversationId", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post(':conversationId/stop')
  async stop(@Param('conversationId') conversationId: string, @Req() request: AuthenticatedRequest) {
    this.sessions.assertCsrfForCookie(request);
    return success(await this.conversations.stop(request.user!.user.id, conversationId), 'AI conversation stopped');
  }
}
