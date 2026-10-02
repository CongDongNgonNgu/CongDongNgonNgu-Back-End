import {
  Body,
  Controller,
  Get,
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
import { CreateEventDto, ListEventsQueryDto } from './event.dto';
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
}
