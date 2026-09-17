import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenGuard, type AuthenticatedRequest } from '../auth/guards/access-token.guard';
import { SessionService } from '../auth/session/session.service';
import { success } from '../common/http/api-response';
import { ExchangePreferenceUpdateDto } from './exchange.dto';
import { ExchangeService } from './exchange.service';

@Controller('exchange')
export class ExchangeController {
  constructor(
    private readonly exchanges: ExchangeService,
    private readonly sessions: SessionService,
  ) {}

  @Get('preferences')
  @UseGuards(AccessTokenGuard)
  async ownPreferences(@Req() request: AuthenticatedRequest) {
    return success(
      await this.exchanges.getOwnPreferences(request.user!.user.id),
      'Exchange preferences',
    );
  }

  @Patch('preferences')
  @UseGuards(AccessTokenGuard)
  async updateOwnPreferences(
    @Body() input: ExchangePreferenceUpdateDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.exchanges.updateOwnPreferences(request.user!.user.id, input),
      'Exchange preferences updated',
    );
  }

  @Get('profile-preview/:userId')
  @UseGuards(AccessTokenGuard)
  async publicBuddyPreview(
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.exchanges.getPublicBuddyProjection(userId, request.user!.user.id),
      'Exchange buddy preview',
    );
  }
}
