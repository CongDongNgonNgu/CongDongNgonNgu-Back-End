import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
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
  LanguageHubQueryDto,
  LanguageSlugParamsDto,
  ProfileUpdateDto,
} from './profile.dto';
import { ProfileService } from './profile.service';

@ApiTags("Profiles")
@ApiResponse({ status: 400, description: 'Request validation failed', schema: { $ref: '#/components/schemas/ApiError' } })
@Controller()
export class ProfileController {
  constructor(
    private readonly profiles: ProfileService,
    private readonly sessions: SessionService,
  ) {}

  @ApiOperation({ summary: "Languages - Profiles" })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @ApiTags('Languages')
  @Get('languages')
  async languages(@Query() query: LanguageCatalogQueryDto) {
    return success(
      await this.profiles.listLanguages(query.search, query.limit),
      'Language catalog',
    );
  }

  @ApiOperation({ summary: "Language Overview - Profiles" })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @ApiTags('Languages')
  @Get('languages/:slug/overview')
  async languageOverview(
    @Param() params: LanguageSlugParamsDto,
    @Query() query: LanguageHubQueryDto,
  ) {
    return success(
      await this.profiles.getLanguageOverview(params.slug, query),
      'Language overview',
    );
  }

  @ApiOperation({ summary: "Language - Profiles" })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @ApiTags('Languages')
  @Get('languages/:slug')
  async language(@Param() params: LanguageSlugParamsDto) {
    return success(
      await this.profiles.getLanguageBySlug(params.slug),
      'Language',
    );
  }

  @ApiOperation({ summary: "Own Profile - Profiles" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get('profile')
  @UseGuards(AccessTokenGuard)
  async ownProfile(@Req() request: AuthenticatedRequest) {
    return success(
      await this.profiles.getOwnProfile(request.user!.user.id),
      'Own profile',
    );
  }

  @ApiOperation({ summary: "Update Own Profile - Profiles" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Public Profile - Profiles" })
  @ApiParam({ name: "userId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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
