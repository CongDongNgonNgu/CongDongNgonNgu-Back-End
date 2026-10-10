import { Body, Controller, Get, Header, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req,
  Sse, SseSignal, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessTokenGuard, type AuthenticatedRequest } from '../auth/guards/access-token.guard';
import { SessionFailure, SessionService } from '../auth/session/session.service';
import { success } from '../common/http/api-response';
import { PostgresDirectConversationRepository } from './postgres-direct-conversation.repository';
import { PostgresDirectMessageRepository } from './postgres-direct-message.repository';
import { MessageStreamService } from './message-stream.service';
import { MessageFailure } from './message-failure';
import { ConversationListDto, MarkDirectMessageReadDto, MessageHistoryDto, MessageStreamQueryDto,
  OpenDirectConversationDto, SendDirectMessageDto } from './messaging.dto';

@Controller('exchange/conversations')
@UseGuards(AccessTokenGuard)
export class MessagingController {
  constructor(private readonly conversations: PostgresDirectConversationRepository,
    private readonly messages: PostgresDirectMessageRepository, private readonly streams: MessageStreamService,
    private readonly sessions: SessionService, private readonly config: ConfigService) {}

  @Post()
  async open(@Req() request: AuthenticatedRequest, @Body() input: OpenDirectConversationDto) {
    this.sessions.assertCsrfForCookie(request);
    return success(await this.conversations.open(request.user!.user.id, input.partnerUserId));
  }

  @Get()
  async list(@Req() request: AuthenticatedRequest, @Query() query: ConversationListDto) {
    return success(await this.conversations.list(request.user!.user.id, query));
  }

  @Get(':conversationId')
  async get(@Req() request: AuthenticatedRequest,
    @Param('conversationId', new ParseUUIDPipe({ version: '4' })) id: string) {
    return success(await this.conversations.get(request.user!.user.id, id));
  }

  @Get(':conversationId/messages')
  async history(@Req() request: AuthenticatedRequest, @Query() query: MessageHistoryDto,
    @Param('conversationId', new ParseUUIDPipe({ version: '4' })) id: string) {
    return success(await this.messages.history(request.user!.user.id, id, query));
  }

  @Post(':conversationId/messages')
  async send(@Req() request: AuthenticatedRequest, @Body() input: SendDirectMessageDto,
    @Param('conversationId', new ParseUUIDPipe({ version: '4' })) id: string) {
    this.sessions.assertCsrfForCookie(request);
    return success(await this.messages.send(request.user!.user.id, id, input));
  }

  @Post(':conversationId/read')
  @HttpCode(200)
  async read(@Req() request: AuthenticatedRequest, @Body() input: MarkDirectMessageReadDto,
    @Param('conversationId', new ParseUUIDPipe({ version: '4' })) id: string) {
    this.sessions.assertCsrfForCookie(request);
    await this.messages.markRead(request.user!.user.id, id, input.sequence);
    return success(null);
  }

  @Sse(':conversationId/stream')
  @Header('Cache-Control', 'private, no-store, no-transform')
  @Header('X-Accel-Buffering', 'no')
  async stream(@Req() request: AuthenticatedRequest, @Query() _query: MessageStreamQueryDto,
    @Param('conversationId', new ParseUUIDPipe({ version: '4' })) id: string,
    @SseSignal() signal: AbortSignal, @Headers('last-event-id') lastEventId?: string) {
    const origin = request.headers.origin;
    if (origin && !this.config.get<string[]>('app.corsOrigins')?.includes(origin))
      throw new MessageFailure('MESSAGE_ORIGIN_DENIED', 403, 'Request origin is not allowed');
    const actor = request.user!.user.id;
    const session = request.user!.claims.sid;
    const token = request.headers.authorization!.slice('Bearer '.length).trim();
    return this.streams.open(actor, id, session, async () => {
      const current = await this.sessions.authenticate(token);
      if (current.user.id !== actor || current.claims.sid !== session) throw new SessionFailure('AUTH_SESSION_EXPIRED');
    }, signal, lastEventId);
  }
}
