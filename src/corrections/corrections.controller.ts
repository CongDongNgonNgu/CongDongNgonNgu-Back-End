import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenGuard, type AuthenticatedRequest } from '../auth/guards/access-token.guard';
import { SessionService } from '../auth/session/session.service';
import { success } from '../common/http/api-response';
import { OptionalAccessTokenGuard } from '../community/optional-access-token.guard';
import { CorrectionsService } from './corrections.service';
import {
  AcceptStructuredResponseDto,
  CreateCorrectionRequestDto,
  CreateQuestionDto,
  CreateStructuredResponseDto,
  ListStructuredResponsesQueryDto,
} from './corrections.dto';

@Controller('community')
export class CorrectionsController {
  constructor(
    private readonly corrections: CorrectionsService,
    private readonly sessions: SessionService,
  ) {}

  @Post('correction-requests')
  @UseGuards(AccessTokenGuard)
  async createCorrectionRequest(
    @Body() input: CreateCorrectionRequestDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.corrections.createCorrectionRequest(request.user!.user.id, input),
      'Correction request created',
    );
  }

  @Get('correction-requests/:postId')
  @UseGuards(OptionalAccessTokenGuard)
  async getCorrectionRequest(
    @Param('postId', new ParseUUIDPipe({ version: '4' })) postId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.corrections.getCorrectionRequest(postId, request.user?.user.id ?? null),
      'Correction request',
    );
  }

  @Post('questions')
  @UseGuards(AccessTokenGuard)
  async createQuestion(
    @Body() input: CreateQuestionDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.corrections.createQuestion(request.user!.user.id, input),
      'Question created',
    );
  }

  @Get('questions/:postId')
  @UseGuards(OptionalAccessTokenGuard)
  async getQuestion(
    @Param('postId', new ParseUUIDPipe({ version: '4' })) postId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.corrections.getQuestion(postId, request.user?.user.id ?? null),
      'Question',
    );
  }

  @Post('posts/:postId/structured-responses')
  @UseGuards(AccessTokenGuard)
  async createStructuredResponse(
    @Param('postId', new ParseUUIDPipe({ version: '4' })) postId: string,
    @Body() input: CreateStructuredResponseDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.corrections.createStructuredResponse(postId, request.user!.user.id, input),
      'Structured response created',
    );
  }

  @Get('posts/:postId/structured-responses')
  @UseGuards(OptionalAccessTokenGuard)
  async listStructuredResponses(
    @Param('postId', new ParseUUIDPipe({ version: '4' })) postId: string,
    @Query() query: ListStructuredResponsesQueryDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.corrections.listStructuredResponses(
        postId,
        query,
        request.user?.user.id ?? null,
      ),
      'Structured responses',
    );
  }

  @Get('structured-responses/:responseId')
  @UseGuards(OptionalAccessTokenGuard)
  async getStructuredResponse(
    @Param('responseId', new ParseUUIDPipe({ version: '4' })) responseId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.corrections.getStructuredResponse(
        responseId,
        request.user?.user.id ?? null,
      ),
      'Structured response',
    );
  }

  @Put('structured-responses/:responseId/helpful')
  @UseGuards(AccessTokenGuard)
  async addStructuredResponseHelpfulVote(
    @Param('responseId', new ParseUUIDPipe({ version: '4' })) responseId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.corrections.addStructuredResponseHelpfulVote(
        responseId,
        request.user!.user.id,
      ),
      'Structured response marked helpful',
    );
  }

  @Delete('structured-responses/:responseId/helpful')
  @UseGuards(AccessTokenGuard)
  async removeStructuredResponseHelpfulVote(
    @Param('responseId', new ParseUUIDPipe({ version: '4' })) responseId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.corrections.removeStructuredResponseHelpfulVote(
        responseId,
        request.user!.user.id,
      ),
      'Structured response helpful mark removed',
    );
  }

  @Post('structured-responses/:responseId/library-candidate')
  @UseGuards(AccessTokenGuard)
  async nominateStructuredResponseAsLibraryCandidate(
    @Param('responseId', new ParseUUIDPipe({ version: '4' })) responseId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.corrections.nominateStructuredResponseAsLibraryCandidate(
        responseId,
        request.user!.user.id,
      ),
      'Library candidate submitted for review',
    );
  }

  @Put('posts/:postId/accepted-response')
  @UseGuards(AccessTokenGuard)
  async acceptStructuredResponse(
    @Param('postId', new ParseUUIDPipe({ version: '4' })) postId: string,
    @Body() input: AcceptStructuredResponseDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.corrections.acceptStructuredResponse(
        postId,
        input.responseId,
        request.user!.user.id,
      ),
      'Structured response accepted',
    );
  }

  @Delete('posts/:postId/accepted-response')
  @UseGuards(AccessTokenGuard)
  async revokeStructuredResponseAcceptance(
    @Param('postId', new ParseUUIDPipe({ version: '4' })) postId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.corrections.revokeStructuredResponseAcceptance(
        postId,
        request.user!.user.id,
      ),
      'Structured response acceptance revoked',
    );
  }
}
