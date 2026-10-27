import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
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

@ApiTags("Corrections")
@ApiResponse({ status: 400, description: 'Request validation failed', schema: { $ref: '#/components/schemas/ApiError' } })
@Controller('community')
export class CorrectionsController {
  constructor(
    private readonly corrections: CorrectionsService,
    private readonly sessions: SessionService,
  ) {}

  @ApiOperation({ summary: "Create Correction Request - Corrections" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Get Correction Request - Corrections", security: [{}, { bearer: [] }] })
  @ApiParam({ name: "postId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Create Question - Corrections" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Get Question - Corrections", security: [{}, { bearer: [] }] })
  @ApiParam({ name: "postId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Create Structured Response - Corrections" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "postId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "List Structured Responses - Corrections", security: [{}, { bearer: [] }] })
  @ApiParam({ name: "postId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Get Structured Response - Corrections", security: [{}, { bearer: [] }] })
  @ApiParam({ name: "responseId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Add Structured Response Helpful Vote - Corrections" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "responseId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Remove Structured Response Helpful Vote - Corrections" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "responseId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Nominate Structured Response As Library Candidate - Corrections" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "responseId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Accept Structured Response - Corrections" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "postId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Revoke Structured Response Acceptance - Corrections" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "postId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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
