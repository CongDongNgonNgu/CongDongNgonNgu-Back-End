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
