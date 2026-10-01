import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { success } from '../common/http/api-response';
import { AccessTokenGuard, type AuthenticatedRequest } from '../auth/guards/access-token.guard';
import { SessionService } from '../auth/session/session.service';
import { OptionalAccessTokenGuard } from '../community/optional-access-token.guard';
import {
  CreateSpeakingRoomDto,
  HeartbeatSpeakingRoomDto,
  IssueMediaSessionDto,
  JoinSpeakingRoomDto,
  LeaveSpeakingRoomDto,
  ListSpeakingRoomsQueryDto,
  SpeakingRoomActionDto,
  SpeakingRoomChatMessageDto,
  SpeakingRoomChatQueryDto,
  SpeakingRoomMuteDto,
  SpeakingRoomQueueDecisionDto,
  SpeakingRoomReportDto,
} from './room.dto';
import { SpeakingRoomService } from './room.service';

@Controller('rooms')
export class SpeakingRoomController {
  constructor(
    private readonly rooms: SpeakingRoomService,
    private readonly sessions: SessionService,
  ) {}

  @Post()
  @UseGuards(AccessTokenGuard)
  async createRoom(
    @Body() input: CreateSpeakingRoomDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.rooms.createRoom(request.user!.user.id, input),
      'Speaking room created',
    );
  }

  @Get()
  @UseGuards(OptionalAccessTokenGuard)
  async listRooms(
    @Query() query: ListSpeakingRoomsQueryDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.rooms.listRooms(query, request.user?.user.id ?? null),
      'Speaking rooms',
    );
  }

  @Get(':roomId')
  @UseGuards(OptionalAccessTokenGuard)
  async getRoom(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Headers('x-room-access-token') accessToken: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.rooms.getRoom(roomId, request.user?.user.id ?? null, accessToken),
      'Speaking room',
    );
  }

  @Post(':roomId/join')
  @UseGuards(AccessTokenGuard)
  async joinRoom(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Headers('x-room-access-token') accessToken: string | undefined,
    @Body() input: JoinSpeakingRoomDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.rooms.joinRoom(roomId, request.user!.user.id, input, accessToken),
      'Joined speaking room',
    );
  }

  @Post(':roomId/leave')
  @UseGuards(AccessTokenGuard)
  async leaveRoom(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Headers('x-room-access-token') accessToken: string | undefined,
    @Body() input: LeaveSpeakingRoomDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.rooms.leaveRoom(roomId, request.user!.user.id, input, accessToken),
      'Left speaking room',
    );
  }

  @Post(':roomId/presence/heartbeat')
  @UseGuards(AccessTokenGuard)
  async heartbeat(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Headers('x-room-access-token') accessToken: string | undefined,
    @Body() input: HeartbeatSpeakingRoomDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.rooms.heartbeat(roomId, request.user!.user.id, input, accessToken),
      'Speaking room presence updated',
    );
  }

  @Get(':roomId/participants')
  @UseGuards(AccessTokenGuard)
  async listParticipants(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Headers('x-room-access-token') accessToken: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.rooms.listParticipants(roomId, request.user!.user.id, accessToken),
      'Speaking room participants',
    );
  }

  @Post(':roomId/queue/raise-hand')
  @UseGuards(AccessTokenGuard)
  async raiseHand(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Headers('x-room-access-token') accessToken: string | undefined,
    @Body() input: SpeakingRoomActionDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.rooms.raiseHandWithRequest(roomId, request.user!.user.id, input.requestId, accessToken),
      'Room hand raised',
    );
  }

  @Post(':roomId/queue/cancel')
  @UseGuards(AccessTokenGuard)
  async cancelHand(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Headers('x-room-access-token') accessToken: string | undefined,
    @Body() input: SpeakingRoomActionDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.rooms.cancelHand(roomId, request.user!.user.id, input, accessToken),
      'Room hand raise cancelled',
    );
  }

  @Get(':roomId/queue')
  @UseGuards(AccessTokenGuard)
  async listQueue(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Headers('x-room-access-token') accessToken: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.rooms.listQueue(roomId, request.user!.user.id, accessToken),
      'Speaking room queue',
    );
  }

  @Post(':roomId/queue/:queueEntryId/decision')
  @UseGuards(AccessTokenGuard)
  async decideQueue(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Param('queueEntryId', new ParseUUIDPipe({ version: '4' })) queueEntryId: string,
    @Headers('x-room-access-token') accessToken: string | undefined,
    @Body() input: SpeakingRoomQueueDecisionDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.rooms.decideQueue(roomId, request.user!.user.id, queueEntryId, input, accessToken),
      'Speaking room queue decision applied',
    );
  }

  @Post(':roomId/participants/:participantId/promote')
  @UseGuards(AccessTokenGuard)
  async promoteParticipant(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Param('participantId', new ParseUUIDPipe({ version: '4' })) participantId: string,
    @Headers('x-room-access-token') accessToken: string | undefined,
    @Body() input: SpeakingRoomActionDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.rooms.promoteParticipant(roomId, request.user!.user.id, participantId, input, accessToken),
      'Speaking room participant promoted',
    );
  }

  @Post(':roomId/participants/:participantId/demote')
  @UseGuards(AccessTokenGuard)
  async demoteParticipant(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Param('participantId', new ParseUUIDPipe({ version: '4' })) participantId: string,
    @Headers('x-room-access-token') accessToken: string | undefined,
    @Body() input: SpeakingRoomActionDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.rooms.demoteParticipant(roomId, request.user!.user.id, participantId, input, accessToken),
      'Speaking room participant demoted',
    );
  }

  @Post(':roomId/participants/:participantId/mute')
  @UseGuards(AccessTokenGuard)
  async muteParticipant(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Param('participantId', new ParseUUIDPipe({ version: '4' })) participantId: string,
    @Headers('x-room-access-token') accessToken: string | undefined,
    @Body() input: SpeakingRoomMuteDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.rooms.muteParticipant(roomId, request.user!.user.id, participantId, input, accessToken),
      'Speaking room participant muted',
    );
  }

  @Post(':roomId/participants/:participantId/unmute')
  @UseGuards(AccessTokenGuard)
  async unmuteParticipant(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Param('participantId', new ParseUUIDPipe({ version: '4' })) participantId: string,
    @Headers('x-room-access-token') accessToken: string | undefined,
    @Body() input: SpeakingRoomActionDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.rooms.unmuteParticipant(roomId, request.user!.user.id, participantId, input, accessToken),
      'Speaking room participant unmuted',
    );
  }

  @Post(':roomId/participants/:participantId/remove')
  @UseGuards(AccessTokenGuard)
  async removeParticipant(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Param('participantId', new ParseUUIDPipe({ version: '4' })) participantId: string,
    @Headers('x-room-access-token') accessToken: string | undefined,
    @Body() input: SpeakingRoomActionDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.rooms.removeParticipant(roomId, request.user!.user.id, participantId, input, accessToken),
      'Speaking room participant removed',
    );
  }

  @Post(':roomId/participants/:participantId/block')
  @UseGuards(AccessTokenGuard)
  async blockParticipant(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Param('participantId', new ParseUUIDPipe({ version: '4' })) participantId: string,
    @Headers('x-room-access-token') accessToken: string | undefined,
    @Body() input: SpeakingRoomActionDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.rooms.blockParticipant(roomId, request.user!.user.id, participantId, input, accessToken),
      'Speaking room participant blocked',
    );
  }

  @Post(':roomId/participants/:participantId/unblock')
  @UseGuards(AccessTokenGuard)
  async unblockParticipant(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Param('participantId', new ParseUUIDPipe({ version: '4' })) participantId: string,
    @Headers('x-room-access-token') accessToken: string | undefined,
    @Body() input: SpeakingRoomActionDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.rooms.unblockParticipant(roomId, request.user!.user.id, participantId, input, accessToken),
      'Speaking room participant unblocked',
    );
  }

  @Post(':roomId/participants/:participantId/report')
  @UseGuards(AccessTokenGuard)
  async reportParticipant(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Param('participantId', new ParseUUIDPipe({ version: '4' })) participantId: string,
    @Headers('x-room-access-token') accessToken: string | undefined,
    @Body() input: SpeakingRoomReportDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.rooms.reportParticipant(roomId, request.user!.user.id, participantId, input, accessToken),
      'Speaking room report submitted',
    );
  }

  @Get(':roomId/moderation/audit')
  @UseGuards(AccessTokenGuard)
  async moderationAudit(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Headers('x-room-access-token') accessToken: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.rooms.listModerationAudit(roomId, request.user!.user.id, accessToken),
      'Speaking room moderation audit',
    );
  }

  @Post(':roomId/chat')
  @UseGuards(AccessTokenGuard)
  async sendChat(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Headers('x-room-access-token') accessToken: string | undefined,
    @Body() input: SpeakingRoomChatMessageDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.rooms.sendChat(roomId, request.user!.user.id, input, accessToken),
      'Speaking room message sent',
    );
  }

  @Get(':roomId/chat')
  @UseGuards(AccessTokenGuard)
  async listChat(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Headers('x-room-access-token') accessToken: string | undefined,
    @Query() query: SpeakingRoomChatQueryDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.rooms.listChat(roomId, request.user!.user.id, query, accessToken),
      'Speaking room chat',
    );
  }

  @Post(':roomId/media-session')
  @UseGuards(AccessTokenGuard)
  async issueMediaSession(
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Body() input: IssueMediaSessionDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.rooms.issueMediaSession(roomId, request.user!.user.id, input),
      'Speaking room media session',
    );
  }
}
