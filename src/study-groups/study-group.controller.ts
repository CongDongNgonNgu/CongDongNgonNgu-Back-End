import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Header, Headers, Sse, SseSignal } from '@nestjs/common';
import { SessionFailure } from '../auth/session/session.service';
import { MessageFailure } from '../messaging/message-failure';
import { GroupStreamService } from './group-stream.service';
import {
  StudyGroupSyncDto,
  StudyGroupReadDto,
  StudyGroupStreamQueryDto,
} from './study-group.dto';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  AccessTokenGuard,
  type AuthenticatedRequest,
} from "../auth/guards/access-token.guard";
import { SessionService } from "../auth/session/session.service";
import { success } from "../common/http/api-response";
import { StudyGroupService } from "./study-group.service";
import {
  AcceptStudyGroupInvitationDto,
  CreateStudyGroupDto,
  ConnectedPartnerInvitationDto,
  EmptyStudyGroupDto,
  GroupPageDto,
  StudyGroupOwnershipDto,
  StudyGroupReportDto,
  StudyGroupRoleDto,
  StudyGroupTextDto,
} from "./study-group.dto";
const uuidPipe = new ParseUUIDPipe({ version: "4" });
@ApiTags("Study groups")
@ApiResponse({ status: 400, description: 'Request validation failed', schema: { $ref: '#/components/schemas/ApiError' } })
@ApiBearerAuth('bearer')
@ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
@Controller("study-groups")
@UseGuards(AccessTokenGuard)
export class StudyGroupController {
  constructor(
    private readonly groups: StudyGroupService,
    private readonly sessions: SessionService,
    private readonly streams:GroupStreamService,
    private readonly config:ConfigService,
  ) {}
  @ApiOperation({ summary: "List Groups - Study groups" })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get("")
  async listGroups(
    @Query() query: GroupPageDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.groups.listGroups(this.actor(request, false), query),
    );
  }

  @ApiOperation({ summary: "Create Group - Study groups" })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post("")
  async createGroup(
    @Body() input: CreateStudyGroupDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.groups.createGroup(this.actor(request, true), input),
    );
  }

  @ApiOperation({ summary: "Accept Invitation - Study groups" })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post("invitations/accept")
  @HttpCode(200)
  async acceptInvitation(
    @Body() input: AcceptStudyGroupInvitationDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.groups.acceptInvitation(this.actor(request, true), input),
    );
  }

  @ApiOperation({ summary: "Get Group - Study groups" })
  @ApiParam({ name: "groupId", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get(":groupId")
  async getGroup(
    @Param("groupId", uuidPipe) groupId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.groups.getGroup(this.actor(request, false), groupId),
    );
  }

  @ApiOperation({ summary: "List Members - Study groups" })
  @ApiParam({ name: "groupId", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get(":groupId/members")
  async listMembers(
    @Param("groupId", uuidPipe) groupId: string,
    @Query() query: GroupPageDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.groups.listMembers(this.actor(request, false), groupId, query),
    );
  }

  @ApiOperation({ summary: "Issue Invitation - Study groups" })
  @ApiParam({ name: "groupId", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post(":groupId/invitations")
  @HttpCode(200)
  async issueInvitation(
    @Param("groupId", uuidPipe) groupId: string,
    @Body() _input: EmptyStudyGroupDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.groups.issueInvitation(this.actor(request, true), groupId),
    );
  }

  @ApiOperation({ summary: "Issue Connected Partner Invitation - Study groups" })
  @ApiParam({ name: "groupId", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post(":groupId/invitations/connected-partner")
  @HttpCode(200)
  async issueConnectedPartnerInvitation(
    @Param("groupId", uuidPipe) groupId: string,
    @Body() input: ConnectedPartnerInvitationDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(await this.groups.issueConnectedPartnerInvitation(
      this.actor(request, true), groupId, input.partnerUserId,
    ));
  }

  @ApiOperation({ summary: "List Invitations - Study groups" })
  @ApiParam({ name: "groupId", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get(":groupId/invitations")
  async listInvitations(
    @Param("groupId", uuidPipe) groupId: string,
    @Query() query: GroupPageDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.groups.listInvitations(
        this.actor(request, false),
        groupId,
        query,
      ),
    );
  }

  @ApiOperation({ summary: "Revoke Invitation - Study groups" })
  @ApiParam({ name: "groupId", required: true, schema: { type: 'string' } })
  @ApiParam({ name: "inviteId", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Delete(":groupId/invitations/:inviteId")
  async revokeInvitation(
    @Param("groupId", uuidPipe) groupId: string,
    @Param("inviteId", uuidPipe) inviteId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.groups.revokeInvitation(
        this.actor(request, true),
        groupId,
        inviteId,
      ),
    );
  }

  @ApiOperation({ summary: "Leave Group - Study groups" })
  @ApiParam({ name: "groupId", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post(":groupId/leave")
  @HttpCode(200)
  async leaveGroup(
    @Param("groupId", uuidPipe) groupId: string,
    @Body() _input: EmptyStudyGroupDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.groups.leaveGroup(this.actor(request, true), groupId),
    );
  }

  @ApiOperation({ summary: "Remove Member - Study groups" })
  @ApiParam({ name: "groupId", required: true, schema: { type: 'string' } })
  @ApiParam({ name: "userId", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Delete(":groupId/members/:userId")
  async removeMember(
    @Param("groupId", uuidPipe) groupId: string,
    @Param("userId", uuidPipe) userId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.groups.removeMember(
        this.actor(request, true),
        groupId,
        userId,
      ),
    );
  }

  @ApiOperation({ summary: "Set Role - Study groups" })
  @ApiParam({ name: "groupId", required: true, schema: { type: 'string' } })
  @ApiParam({ name: "userId", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Patch(":groupId/members/:userId/role")
  async setRole(
    @Param("groupId", uuidPipe) groupId: string,
    @Param("userId", uuidPipe) userId: string,
    @Body() input: StudyGroupRoleDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.groups.setRole(
        this.actor(request, true),
        groupId,
        userId,
        input,
      ),
    );
  }

  @ApiOperation({ summary: "Transfer Ownership - Study groups" })
  @ApiParam({ name: "groupId", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post(":groupId/ownership")
  @HttpCode(200)
  async transferOwnership(
    @Param("groupId", uuidPipe) groupId: string,
    @Body() input: StudyGroupOwnershipDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.groups.transferOwnership(
        this.actor(request, true),
        groupId,
        input,
      ),
    );
  }

  @ApiOperation({ summary: "Archive Group - Study groups" })
  @ApiParam({ name: "groupId", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post(":groupId/archive")
  @HttpCode(200)
  async archiveGroup(
    @Param("groupId", uuidPipe) groupId: string,
    @Body() _input: EmptyStudyGroupDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.groups.archiveGroup(this.actor(request, true), groupId),
    );
  }

  @ApiOperation({ summary: "Sync - Study groups" })
  @ApiParam({ name: "groupId", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post(':groupId/texts/sync')
  @HttpCode(200)
  async sync(
    @Param('groupId', uuidPipe) groupId: string,
    @Body() input: StudyGroupSyncDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.groups.syncTexts(this.actor(request, true), groupId, input),
    );
  }
  @ApiOperation({ summary: "Mark Read - Study groups" })
  @ApiParam({ name: "groupId", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post(':groupId/read')
  @HttpCode(200)
  async markRead(
    @Param('groupId', uuidPipe) groupId: string,
    @Body() input: StudyGroupReadDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.groups.markRead(
        this.actor(request, true),
        groupId,
        input.textId,
      ),
    );
  }
  @ApiOperation({ summary: "Context - Study groups" })
  @ApiParam({ name: "groupId", required: true, schema: { type: 'string' } })
  @ApiParam({ name: "textId", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get(':groupId/texts/:textId/context')
  async context(
    @Param('groupId', uuidPipe) groupId: string,
    @Param('textId', uuidPipe) textId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.groups.getTextContext(
        this.actor(request, false),
        groupId,
        textId,
      ),
    );
  }
  @ApiOperation({ summary: "Stream - Study groups" })
  @ApiParam({ name: "groupId", required: true, schema: { type: 'string' } })
  @ApiHeader({ name: "last-event-id", required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Server-sent event stream; existing access and reconnect policies apply', content: { 'text/event-stream': { schema: { type: 'string' } } } })
  @Sse(':groupId/stream')
  @Header('Cache-Control', 'private, no-store, no-transform')
  @Header('X-Accel-Buffering', 'no')
  async stream(
    @Param('groupId', uuidPipe) groupId: string,
    @Query() _query: StudyGroupStreamQueryDto,
    @Req() request: AuthenticatedRequest,
    @SseSignal() signal: AbortSignal,
    @Headers('last-event-id') lastEventId?: string,
  ) {
    const origin = request.headers.origin;
    if (
      origin &&
      !this.config.get<string[]>('app.corsOrigins')?.includes(origin)
    )
      throw new MessageFailure(
        'MESSAGE_ORIGIN_DENIED',
        403,
        'Request origin is not allowed',
      );
    const actor = request.user!.user.id,
      session = request.user!.claims.sid,
      token = request.headers.authorization!.slice('Bearer '.length).trim();
    return this.streams.open(
      actor,
      groupId,
      session,
      async () => {
        const current = await this.sessions.authenticate(token);
        if (current.user.id !== actor || current.claims.sid !== session)
          throw new SessionFailure('AUTH_SESSION_EXPIRED');
      },
      signal,
      lastEventId,
    );
  }
  @ApiOperation({ summary: "List Texts - Study groups" })
  @ApiParam({ name: "groupId", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get(":groupId/texts")
  async listTexts(
    @Param("groupId", uuidPipe) groupId: string,
    @Query() query: GroupPageDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.groups.listTexts(this.actor(request, false), groupId, query),
    );
  }

  @ApiOperation({ summary: "Create Text - Study groups" })
  @ApiParam({ name: "groupId", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post(":groupId/texts")
  async createText(
    @Param("groupId", uuidPipe) groupId: string,
    @Body() input: StudyGroupTextDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.groups.createText(this.actor(request, true), groupId, input),
    );
  }

  @ApiOperation({ summary: "Hide Text - Study groups" })
  @ApiParam({ name: "groupId", required: true, schema: { type: 'string' } })
  @ApiParam({ name: "textId", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post(":groupId/texts/:textId/hide")
  @HttpCode(200)
  async hideText(
    @Param("groupId", uuidPipe) groupId: string,
    @Param("textId", uuidPipe) textId: string,
    @Body() _input: EmptyStudyGroupDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.groups.hideText(this.actor(request, true), groupId, textId),
    );
  }

  @ApiOperation({ summary: "Report Text - Study groups" })
  @ApiParam({ name: "groupId", required: true, schema: { type: 'string' } })
  @ApiParam({ name: "textId", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post(":groupId/texts/:textId/reports")
  @HttpCode(200)
  async reportText(
    @Param("groupId", uuidPipe) groupId: string,
    @Param("textId", uuidPipe) textId: string,
    @Body() input: StudyGroupReportDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.groups.reportText(
        this.actor(request, true),
        groupId,
        textId,
        input,
      ),
    );
  }

  @ApiOperation({ summary: "List Reports - Study groups" })
  @ApiParam({ name: "groupId", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get(":groupId/reports")
  async listReports(
    @Param("groupId", uuidPipe) groupId: string,
    @Query() query: GroupPageDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.groups.listReports(this.actor(request, false), groupId, query),
    );
  }

  @ApiOperation({ summary: "Resolve Report - Study groups" })
  @ApiParam({ name: "groupId", required: true, schema: { type: 'string' } })
  @ApiParam({ name: "reportId", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post(":groupId/reports/:reportId/resolve")
  @HttpCode(200)
  async resolveReport(
    @Param("groupId", uuidPipe) groupId: string,
    @Param("reportId", uuidPipe) reportId: string,
    @Body() _input: EmptyStudyGroupDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.groups.resolveReport(
        this.actor(request, true),
        groupId,
        reportId,
      ),
    );
  }

  private actor(request: AuthenticatedRequest, mutation: boolean) {
    if (mutation) this.sessions.assertCsrfForCookie(request);
    return request.user!.user.id;
  }
}
