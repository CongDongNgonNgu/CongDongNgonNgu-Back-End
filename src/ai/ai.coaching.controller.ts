import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, type AuthenticatedRequest } from '../auth/guards/access-token.guard';
import { SessionService } from '../auth/session/session.service';
import { success } from '../common/http/api-response';
import { AiCoachingService } from './ai.coaching.service';
import { AiGrammarCoachDto, AiWritingCoachDto } from './ai.coaching.dto';

@ApiTags("AI")
@ApiResponse({ status: 400, description: 'Request validation failed', schema: { $ref: '#/components/schemas/ApiError' } })
@ApiBearerAuth('bearer')
@ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
@Controller('ai/coaching')
@UseGuards(AccessTokenGuard)
export class AiCoachingController {
  constructor(
    private readonly coaching: AiCoachingService,
    private readonly sessions: SessionService,
  ) {}

  @ApiOperation({ summary: "Writing - AI" })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post('writing')
  async writing(@Body() input: AiWritingCoachDto, @Req() request: AuthenticatedRequest) {
    this.sessions.assertCsrfForCookie(request);
    return success(await this.coaching.write(request.user!.user.id, input), 'AI writing coaching');
  }

  @ApiOperation({ summary: "Grammar - AI" })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post('grammar')
  async grammar(@Body() input: AiGrammarCoachDto, @Req() request: AuthenticatedRequest) {
    this.sessions.assertCsrfForCookie(request);
    return success(await this.coaching.grammar(request.user!.user.id, input), 'AI grammar coaching');
  }
}
