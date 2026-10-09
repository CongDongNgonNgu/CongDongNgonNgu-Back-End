import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { AccessTokenGuard, type AuthenticatedRequest } from '../auth/guards/access-token.guard';
import { SessionFailure, SessionService } from '../auth/session/session.service';
import { success } from '../common/http/api-response';
import { ListNotificationsQueryDto, MarkNotificationsReadDto } from './notification.dto';
import { UpdateNotificationPreferencesDto } from './notification-preference.dto';
import { NotificationPreferenceService } from './notification-preference.service';
import { NotificationService } from './notification.service';
import {
  NotificationRealtimeService,
  type NotificationRealtimeEvent,
} from './notification-realtime.service';

@Controller('notifications')
export class NotificationController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly preferences: NotificationPreferenceService,
    private readonly sessions: SessionService,
    private readonly realtime: NotificationRealtimeService,
  ) {}

  @Get()
  @UseGuards(AccessTokenGuard)
  async list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListNotificationsQueryDto,
  ) {
    return success(
      await this.notifications.list(request.user!.user.id, query),
      'Notifications',
    );
  }

  @Get('unread-count')
  @UseGuards(AccessTokenGuard)
  async unreadCount(@Req() request: AuthenticatedRequest) {
    return success(
      await this.notifications.unreadCount(request.user!.user.id),
      'Unread notification count',
    );
  }

  @Get('preferences')
  @UseGuards(AccessTokenGuard)
  async preferencesForOwner(@Req() request: AuthenticatedRequest) {
    return success(
      await this.preferences.get(request.user!.user.id),
      'Notification preferences',
    );
  }

  @Patch('preferences')
  @UseGuards(AccessTokenGuard)
  async updatePreferences(
    @Req() request: AuthenticatedRequest,
    @Body() input: UpdateNotificationPreferencesDto,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.preferences.update(request.user!.user.id, input.preferences),
      'Notification preferences updated',
    );
  }

  @Sse('stream')
  @Header('Cache-Control', 'no-cache, no-transform')
  @Header('Connection', 'keep-alive')
  @Header('X-Accel-Buffering', 'no')
  @UseGuards(AccessTokenGuard)
  stream(
    @Req() request: AuthenticatedRequest,
    @Headers('last-event-id') lastEventId?: string,
  ): Observable<NotificationRealtimeEvent> {
    const userId = request.user!.user.id;
    const sessionId = request.user!.claims.sid;
    const token = request.headers.authorization!.slice('Bearer '.length).trim();
    return this.realtime.stream(userId, lastEventId, async () => {
      const current = await this.sessions.authenticate(token);
      if (current.user.id !== userId || current.claims.sid !== sessionId) {
        throw new SessionFailure('AUTH_SESSION_EXPIRED');
      }
    });
  }

  @Post('read')
  @UseGuards(AccessTokenGuard)
  async markManyRead(
    @Req() request: AuthenticatedRequest,
    @Body() input: MarkNotificationsReadDto,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.notifications.markManyRead(request.user!.user.id, input.notificationIds),
      'Notifications marked as read',
    );
  }

  @Post(':notificationId/read')
  @UseGuards(AccessTokenGuard)
  async markOneRead(
    @Req() request: AuthenticatedRequest,
    @Param('notificationId', new ParseUUIDPipe({ version: '4' })) notificationId: string,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.notifications.markOneRead(request.user!.user.id, notificationId),
      'Notification marked as read',
    );
  }
}
