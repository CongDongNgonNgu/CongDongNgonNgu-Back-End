import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, type AuthenticatedRequest } from '../auth/guards/access-token.guard';
import { success } from '../common/http/api-response';
import { LearningXpService } from './learning-xp.service';

@ApiTags("Learning and reputation")
@ApiResponse({ status: 400, description: 'Request validation failed', schema: { $ref: '#/components/schemas/ApiError' } })
@Controller('learning')
export class LearningProgressController {
  constructor(private readonly learning: LearningXpService) {}

  @ApiOperation({ summary: "Progress - Learning and reputation" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get('progress')
  @UseGuards(AccessTokenGuard)
  async progress(@Req() request: AuthenticatedRequest) {
    return success(
      await this.learning.getProgress(request.user!.user.id),
      'Learning progress',
    );
  }
}
