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
import { CreateSpeakingRoomDto, IssueMediaSessionDto, ListSpeakingRoomsQueryDto } from './room.dto';
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
