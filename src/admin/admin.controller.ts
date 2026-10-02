import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { success } from '../common/http/api-response';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { AccessTokenGuard, type AuthenticatedRequest } from '../auth/guards/access-token.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SessionService } from '../auth/session/session.service';
import type { RoleKey, UserRecord, UserStatus } from '../identity/identity.types';
import {
  AdminAssignReportDto,
  AdminAuditQueryDto,
  AdminContentActionDto,
  AdminReportNoteDto,
  AdminReverseReputationDto,
  AdminReportsQueryDto,
  AdminReplaceRolesDto,
  AdminResolveReportDto,
  AdminUserActionDto,
  AdminUsersQueryDto,
} from './admin.dto';
import { AdminService, type AdminActor } from './admin.service';

@Controller('admin')
@UseGuards(AccessTokenGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly sessions: SessionService,
  ) {}

  @Get('metrics')
  @UseGuards(RolesGuard)
  @Roles('MODERATOR', 'ADMIN')
  async metrics(@CurrentUser() user: UserRecord) {
    return success(await this.admin.metrics(toAdminActor(user)), 'Admin metrics');
  }

  @Get('reports')
  @UseGuards(RolesGuard)
  @Roles('MODERATOR', 'ADMIN')
  async listReports(@Query() query: AdminReportsQueryDto, @CurrentUser() user: UserRecord) {
    return success(await this.admin.listReports(toAdminActor(user), query), 'Moderation reports');
  }

  @Get('reports/:reportId')
  @UseGuards(RolesGuard)
  @Roles('MODERATOR', 'ADMIN')
  async getReport(
    @Param('reportId', new ParseUUIDPipe({ version: '4' })) reportId: string,
    @CurrentUser() user: UserRecord,
  ) {
    return success(await this.admin.getReport(toAdminActor(user), reportId), 'Moderation report');
  }

  @Patch('reports/:reportId/assignment')
  @UseGuards(RolesGuard)
  @Roles('MODERATOR', 'ADMIN')
  async assignReport(
    @Param('reportId', new ParseUUIDPipe({ version: '4' })) reportId: string,
    @Body() input: AdminAssignReportDto,
    @Req() request: AuthenticatedRequest,
    @CurrentUser() user: UserRecord,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(await this.admin.assignReport(toAdminActor(user), reportId, input.assignedToUserId ?? null), 'Moderation report assigned');
  }

  @Post('reports/:reportId/resolve')
  @UseGuards(RolesGuard)
  @Roles('MODERATOR', 'ADMIN')
  async resolveReport(
    @Param('reportId', new ParseUUIDPipe({ version: '4' })) reportId: string,
    @Body() input: AdminResolveReportDto,
    @Req() request: AuthenticatedRequest,
    @CurrentUser() user: UserRecord,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(await this.admin.resolveReport(toAdminActor(user), reportId, input.state, input.reason ?? null), 'Moderation report updated');
  }

  @Post('reports/:reportId/notes')
  @UseGuards(RolesGuard)
  @Roles('MODERATOR', 'ADMIN')
  async addReportNote(
    @Param('reportId', new ParseUUIDPipe({ version: '4' })) reportId: string,
    @Body() input: AdminReportNoteDto,
    @Req() request: AuthenticatedRequest,
    @CurrentUser() user: UserRecord,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(await this.admin.addReportNote(toAdminActor(user), reportId, input.body), 'Moderation note added');
  }

  @Get('reports/:reportId/notes')
  @UseGuards(RolesGuard)
  @Roles('MODERATOR', 'ADMIN')
  async listReportNotes(
    @Param('reportId', new ParseUUIDPipe({ version: '4' })) reportId: string,
    @CurrentUser() user: UserRecord,
  ) {
    return success(await this.admin.listReportNotes(toAdminActor(user), reportId), 'Moderation notes');
  }

  @Post('content/:targetType/:targetId/action')
  @UseGuards(RolesGuard)
  @Roles('MODERATOR', 'ADMIN')
  async moderateContent(
    @Param('targetType') targetType: string,
    @Param('targetId', new ParseUUIDPipe({ version: '4' })) targetId: string,
    @Body() input: AdminContentActionDto,
    @Req() request: AuthenticatedRequest,
    @CurrentUser() user: UserRecord,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(await this.admin.moderateContent(toAdminActor(user), {
      targetType: targetType as 'COMMUNITY_POST' | 'COMMUNITY_COMMENT' | 'LIBRARY_RESOURCE',
      targetId,
      action: input.action,
      reason: input.reason,
    }), 'Content moderation action applied');
  }

  @Post('users/:userId/action')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  async moderateUser(
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @Body() input: AdminUserActionDto,
    @Req() request: AuthenticatedRequest,
    @CurrentUser() user: UserRecord,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(await this.admin.moderateUser(toAdminActor(user), { targetUserId: userId, action: input.action, reason: input.reason }), 'User moderation action applied');
  }

  @Get('users')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  async listUsers(@Query() query: AdminUsersQueryDto, @CurrentUser() user: UserRecord) {
    return success(await this.admin.listUsers(toAdminActor(user), {
      search: query.search,
      status: query.status as UserStatus | undefined,
      role: query.role,
      limit: query.limit,
      offset: query.offset,
    }), 'Admin users');
  }

  @Patch('users/:userId/roles')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  async replaceRoles(
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @Body() input: AdminReplaceRolesDto,
    @Req() request: AuthenticatedRequest,
    @CurrentUser() user: UserRecord,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(await this.admin.replaceRoles(toAdminActor(user), userId, input.roles as RoleKey[]), 'User roles updated');
  }

  @Post('reputation/:entryId/reverse')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  async reverseReputation(
    @Param('entryId', new ParseUUIDPipe({ version: '4' })) entryId: string,
    @Body() input: AdminReverseReputationDto,
    @Req() request: AuthenticatedRequest,
    @CurrentUser() user: UserRecord,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(await this.admin.reverseReputation(toAdminActor(user), { entryId, ...input }), 'Reputation reversal recorded');
  }

  @Get('audit')
  @UseGuards(RolesGuard)
  @Roles('ADMIN')
  async listAudit(@Query() query: AdminAuditQueryDto, @CurrentUser() user: UserRecord) {
    return success(await this.admin.listAudit(toAdminActor(user), query), 'Admin audit log');
  }
}

function toAdminActor(user: UserRecord): AdminActor {
  return { userId: user.id, roles: user.roles };
}
