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
import { AccessTokenGuard, type AuthenticatedRequest } from '../auth/guards/access-token.guard';
import { SessionService } from '../auth/session/session.service';
import { success } from '../common/http/api-response';
import { ListNotificationsQueryDto, MarkNotificationsReadDto } from './notification.dto';
import { NotificationService } from './notification.service';

@Controller('notifications')
export class NotificationController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly sessions: SessionService,
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
