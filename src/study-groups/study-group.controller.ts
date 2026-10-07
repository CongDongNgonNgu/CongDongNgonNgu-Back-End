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
  EmptyStudyGroupDto,
  GroupPageDto,
  StudyGroupOwnershipDto,
  StudyGroupReportDto,
  StudyGroupRoleDto,
  StudyGroupTextDto,
} from "./study-group.dto";
const uuidPipe = new ParseUUIDPipe({ version: "4" });
@Controller("study-groups")
@UseGuards(AccessTokenGuard)
export class StudyGroupController {
  constructor(
    private readonly groups: StudyGroupService,
    private readonly sessions: SessionService,
  ) {}
  @Get("")
  async listGroups(
    @Query() query: GroupPageDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.groups.listGroups(this.actor(request, false), query),
    );
  }

  @Post("")
  async createGroup(
    @Body() input: CreateStudyGroupDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.groups.createGroup(this.actor(request, true), input),
    );
  }

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

  @Get(":groupId")
  async getGroup(
    @Param("groupId", uuidPipe) groupId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.groups.getGroup(this.actor(request, false), groupId),
    );
  }

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
