import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { success } from '../common/http/api-response';
import { SessionService } from '../auth/session/session.service';
import { AccessTokenGuard, type AuthenticatedRequest } from '../auth/guards/access-token.guard';
import {
  LanguageCatalogQueryDto,
  ProfileUpdateDto,
} from './profile.dto';
import { ProfileService } from './profile.service';

@Controller()
export class ProfileController {
  constructor(
    private readonly profiles: ProfileService,
    private readonly sessions: SessionService,
  ) {}

  @Get('languages')
  async languages(@Query() query: LanguageCatalogQueryDto) {
    return success(
      await this.profiles.listLanguages(query.search, query.limit),
      'Language catalog',
    );
  }

  @Get('profile')
  @UseGuards(AccessTokenGuard)
  async ownProfile(@Req() request: AuthenticatedRequest) {
    return success(
      await this.profiles.getOwnProfile(request.user!.user.id),
      'Own profile',
    );
  }

  @Patch('profile')
  @UseGuards(AccessTokenGuard)
  async updateOwnProfile(
    @Body() input: ProfileUpdateDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.profiles.updateOwnProfile(request.user!.user.id, input),
      'Profile updated',
    );
  }

  @Get('profiles/:userId')
  async publicProfile(
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
  ) {
    return success(
      await this.profiles.getPublicProfile(userId),
      'Public profile',
    );
  }
}
