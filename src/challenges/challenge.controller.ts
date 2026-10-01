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

@Controller('challenges')
export class ChallengeController {
  constructor(
    private readonly challenges: ChallengeService,
    private readonly sessions: SessionService,
  ) {}

  @Get()
  async list(@Query() query: ChallengeDiscoveryQueryDto) {
    return success(
      await this.challenges.listPublicChallenges(query),
      'Danh sách thử thách',
    );
  }

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
