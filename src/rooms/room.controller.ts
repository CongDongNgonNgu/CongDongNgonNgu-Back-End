import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
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

@ApiTags("Speaking rooms")
@ApiResponse({ status: 400, description: 'Request validation failed', schema: { $ref: '#/components/schemas/ApiError' } })
@Controller('rooms')
export class SpeakingRoomController {
  constructor(
    private readonly rooms: SpeakingRoomService,
    private readonly sessions: SessionService,
  ) {}

  @ApiOperation({ summary: "Create Room - Speaking rooms" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "List Rooms - Speaking rooms", security: [{}, { bearer: [] }] })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Get Room - Speaking rooms", security: [{}, { bearer: [] }] })
  @ApiParam({ name: "roomId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: "x-room-access-token", required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Join Room - Speaking rooms" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "roomId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: "x-room-access-token", required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Leave Room - Speaking rooms" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "roomId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: "x-room-access-token", required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Heartbeat - Speaking rooms" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "roomId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: "x-room-access-token", required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "List Participants - Speaking rooms" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiParam({ name: "roomId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: "x-room-access-token", required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Raise Hand - Speaking rooms" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "roomId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: "x-room-access-token", required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Cancel Hand - Speaking rooms" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "roomId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: "x-room-access-token", required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "List Queue - Speaking rooms" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiParam({ name: "roomId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: "x-room-access-token", required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Decide Queue - Speaking rooms" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "roomId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: "queueEntryId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: "x-room-access-token", required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Promote Participant - Speaking rooms" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "roomId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: "participantId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: "x-room-access-token", required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Demote Participant - Speaking rooms" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "roomId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: "participantId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: "x-room-access-token", required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Mute Participant - Speaking rooms" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "roomId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: "participantId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: "x-room-access-token", required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Unmute Participant - Speaking rooms" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "roomId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: "participantId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: "x-room-access-token", required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Remove Participant - Speaking rooms" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "roomId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: "participantId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: "x-room-access-token", required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Block Participant - Speaking rooms" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "roomId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: "participantId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: "x-room-access-token", required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Unblock Participant - Speaking rooms" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "roomId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: "participantId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: "x-room-access-token", required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Report Participant - Speaking rooms" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "roomId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: "participantId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: "x-room-access-token", required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Moderation Audit - Speaking rooms" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiParam({ name: "roomId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: "x-room-access-token", required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Send Chat - Speaking rooms" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "roomId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: "x-room-access-token", required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "List Chat - Speaking rooms" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiParam({ name: "roomId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: "x-room-access-token", required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Issue Media Session - Speaking rooms" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "roomId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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
