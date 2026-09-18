import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenGuard, type AuthenticatedRequest } from '../auth/guards/access-token.guard';
import { SessionService } from '../auth/session/session.service';
import { success } from '../common/http/api-response';
import { ExchangeDiscoveryQueryDto, ExchangePreferenceUpdateDto } from './exchange.dto';
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

  @Get('relationships/:userId')
  @UseGuards(AccessTokenGuard)
  async relationship(
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.exchanges.getRelationship(request.user!.user.id, userId),
      'Exchange relationship',
    );
  }

  @Post('relationships/:userId/request')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async requestConnection(
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.exchanges.requestConnection(request.user!.user.id, userId),
      'Exchange connection requested',
    );
  }

  @Post('relationships/:userId/accept')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async acceptConnection(
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.exchanges.acceptConnection(request.user!.user.id, userId),
      'Exchange connection accepted',
    );
  }

  @Post('relationships/:userId/decline')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async declineConnection(
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.exchanges.declineConnection(request.user!.user.id, userId),
      'Exchange connection declined',
    );
  }

  @Post('relationships/:userId/cancel')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async cancelConnection(
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.exchanges.cancelConnection(request.user!.user.id, userId),
      'Exchange connection cancelled',
    );
  }

  @Post('relationships/:userId/disconnect')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async disconnect(
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.exchanges.disconnect(request.user!.user.id, userId),
      'Exchange connection disconnected',
    );
  }

  @Get('discovery')
  @UseGuards(AccessTokenGuard)
  async discovery(
    @Query() query: ExchangeDiscoveryQueryDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.exchanges.discover(request.user!.user.id, query),
      'Exchange discovery',
    );
  }
}
