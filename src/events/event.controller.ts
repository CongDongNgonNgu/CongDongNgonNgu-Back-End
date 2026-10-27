import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { success } from '../common/http/api-response';
import {
  AccessTokenGuard,
  type AuthenticatedRequest,
} from '../auth/guards/access-token.guard';
import { SessionService } from '../auth/session/session.service';
import { OptionalAccessTokenGuard } from '../community/optional-access-token.guard';
import {
  CreateEventDto,
  InviteEventUserDto,
  ListEventsQueryDto,
  MarkEventAttendanceDto,
} from './event.dto';
import { EventService } from './event.service';

@ApiTags("Events")
@ApiResponse({ status: 400, description: 'Request validation failed', schema: { $ref: '#/components/schemas/ApiError' } })
@Controller('events')
export class EventController {
  constructor(
    private readonly events: EventService,
    private readonly sessions: SessionService,
  ) {}

  @ApiOperation({ summary: "List - Events", security: [{}, { bearer: [] }] })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get()
  @UseGuards(OptionalAccessTokenGuard)
  async list(@Query() query: ListEventsQueryDto) {
    return success(
      await this.events.listPublicEvents(query, new Date()),
      'Community events',
    );
  }

  @ApiOperation({ summary: "Detail - Events", security: [{}, { bearer: [] }] })
  @ApiParam({ name: "eventId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get(':eventId')
  @UseGuards(OptionalAccessTokenGuard)
  async detail(
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.events.getEvent(
        eventId,
        request.user?.user.id ?? null,
        new Date(),
      ),
      'Community event',
    );
  }

  @ApiOperation({ summary: "Create - Events" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post()
  @UseGuards(AccessTokenGuard)
  async create(
    @Body() input: CreateEventDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.events.createEvent(request.user!.user.id, input, new Date()),
      'Community event created',
    );
  }

  @ApiOperation({ summary: "Cancel - Events" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "eventId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post(':eventId/cancel')
  @UseGuards(AccessTokenGuard)
  async cancel(
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.events.cancelEvent(eventId, request.user!.user.id, new Date()),
      'Community event cancelled',
    );
  }

  @ApiOperation({ summary: "Invite - Events" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "eventId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post(':eventId/invitations')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard)
  async invite(
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
    @Body() input: InviteEventUserDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.events.inviteEventUser(
        eventId,
        request.user!.user.id,
        input,
        new Date(),
      ),
      'Event invitation created',
    );
  }

  @ApiOperation({ summary: "Revoke Invitation - Events" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "eventId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: "userId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Delete(':eventId/invitations/:userId')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard)
  async revokeInvitation(
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.events.revokeEventInvitation(
        eventId,
        request.user!.user.id,
        userId,
        new Date(),
      ),
      'Event invitation revoked',
    );
  }

  @ApiOperation({ summary: "Registration - Events" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiParam({ name: "eventId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get(':eventId/registration')
  @UseGuards(AccessTokenGuard)
  async registration(
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.events.getRegistration(
        eventId,
        request.user!.user.id,
        new Date(),
      ),
      'Event registration',
    );
  }

  @ApiOperation({ summary: "Register - Events" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "eventId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post(':eventId/register')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard)
  async register(
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.events.registerEvent(
        eventId,
        request.user!.user.id,
        new Date(),
      ),
      'Event registration updated',
    );
  }

  @ApiOperation({ summary: "Unregister - Events" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "eventId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Delete(':eventId/register')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard)
  async unregister(
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.events.cancelRegistration(
        eventId,
        request.user!.user.id,
        new Date(),
      ),
      'Event registration cancelled',
    );
  }

  @ApiOperation({ summary: "Reconcile Reminders - Events" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "eventId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post(':eventId/reminders/reconcile')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard)
  async reconcileReminders(
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.events.reconcileEventReminders(
        eventId,
        request.user!.user.id,
        new Date(),
      ),
      'Event reminders reconciled',
    );
  }

  @ApiOperation({ summary: "Reminders - Events" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiParam({ name: "eventId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get(':eventId/reminders')
  @UseGuards(AccessTokenGuard)
  async reminders(
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.events.getEventReminders(eventId, request.user!.user.id),
      'Event reminders',
    );
  }

  @ApiOperation({ summary: "Attendance - Events" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "eventId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post(':eventId/attendance')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard)
  async attendance(
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
    @Body() input: MarkEventAttendanceDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.events.markEventAttendance(
        eventId,
        request.user!.user.id,
        input,
        new Date(),
      ),
      'Event attendance recorded',
    );
  }
}
