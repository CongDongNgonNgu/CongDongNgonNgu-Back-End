import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
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
import { AccessTokenGuard, type AuthenticatedRequest } from '../auth/guards/access-token.guard';
import { SessionService } from '../auth/session/session.service';
import { ChallengeDiscoveryQueryDto } from './challenge.dto';
import { toPublicParticipation } from './challenge.public';
import { ChallengeService } from './challenge.service';

@ApiTags("Challenges")
@ApiResponse({ status: 400, description: 'Request validation failed', schema: { $ref: '#/components/schemas/ApiError' } })
@Controller('challenges')
export class ChallengeController {
  constructor(
    private readonly challenges: ChallengeService,
    private readonly sessions: SessionService,
  ) {}

  @ApiOperation({ summary: "List - Challenges" })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get()
  async list(@Query() query: ChallengeDiscoveryQueryDto) {
    return success(
      await this.challenges.listPublicChallenges(query),
      'Danh sách thử thách',
    );
  }

  @ApiOperation({ summary: "Progress - Challenges" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiParam({ name: "challengeId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get(':challengeId/progress')
  @UseGuards(AccessTokenGuard)
  async progress(
    @Param('challengeId', new ParseUUIDPipe({ version: '4' })) challengeId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.challenges.getViewerProgress(challengeId, request.user!.user.id),
      'Tiến độ thử thách',
    );
  }

  @ApiOperation({ summary: "Join - Challenges" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "challengeId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post(':challengeId/join')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard)
  async join(
    @Param('challengeId', new ParseUUIDPipe({ version: '4' })) challengeId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    const result = await this.challenges.joinChallenge(challengeId, request.user!.user.id);
    return success({
      replayed: result.replayed,
      participation: toPublicParticipation(result.record),
    }, 'Đã tham gia thử thách');
  }

  @ApiOperation({ summary: "Leave - Challenges" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "challengeId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Delete(':challengeId/join')
  @HttpCode(200)
  @UseGuards(AccessTokenGuard)
  async leave(
    @Param('challengeId', new ParseUUIDPipe({ version: '4' })) challengeId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      toPublicParticipation(await this.challenges.leaveChallenge(challengeId, request.user!.user.id)),
      'Đã rời thử thách',
    );
  }

  @ApiOperation({ summary: "Detail - Challenges" })
  @ApiParam({ name: "challengeId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get(':challengeId')
  async detail(
    @Param('challengeId', new ParseUUIDPipe({ version: '4' })) challengeId: string,
  ) {
    return success(
      await this.challenges.getPublicChallenge(challengeId),
      'Chi tiết thử thách',
    );
  }
}
