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

@Controller('events')
export class EventController {
  constructor(
    private readonly events: EventService,
    private readonly sessions: SessionService,
  ) {}

  @Get()
  @UseGuards(OptionalAccessTokenGuard)
  async list(@Query() query: ListEventsQueryDto) {
    return success(
      await this.events.listPublicEvents(query, new Date()),
      'Community events',
    );
  }

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
