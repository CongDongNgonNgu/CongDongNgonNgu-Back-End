import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
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

@ApiTags("Notifications")
@ApiResponse({ status: 400, description: 'Request validation failed', schema: { $ref: '#/components/schemas/ApiError' } })
@Controller('notifications')
export class NotificationController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly preferences: NotificationPreferenceService,
    private readonly sessions: SessionService,
    private readonly realtime: NotificationRealtimeService,
  ) {}

  @ApiOperation({ summary: "List - Notifications" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Unread Count - Notifications" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get('unread-count')
  @UseGuards(AccessTokenGuard)
  async unreadCount(@Req() request: AuthenticatedRequest) {
    return success(
      await this.notifications.unreadCount(request.user!.user.id),
      'Unread notification count',
    );
  }

  @ApiOperation({ summary: "Preferences For Owner - Notifications" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get('preferences')
  @UseGuards(AccessTokenGuard)
  async preferencesForOwner(@Req() request: AuthenticatedRequest) {
    return success(
      await this.preferences.get(request.user!.user.id),
      'Notification preferences',
    );
  }

  @ApiOperation({ summary: "Update Preferences - Notifications" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Stream - Notifications" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: "last-event-id", required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Server-sent event stream; existing access and reconnect policies apply', content: { 'text/event-stream': { schema: { type: 'string' } } } })
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

  @ApiOperation({ summary: "Mark Many Read - Notifications" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Mark One Read - Notifications" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "notificationId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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
