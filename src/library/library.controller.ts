import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenGuard, type AuthenticatedRequest } from '../auth/guards/access-token.guard';
import { SessionService } from '../auth/session/session.service';
import { success } from '../common/http/api-response';
import { libraryFailure } from './library.errors';
import { LibraryService } from './library.service';
import {
  AttachLibraryProvenanceDto,
  CreateLibraryResourceDto,
  TransitionLibraryReviewDto,
} from './library.dto';
import type { LibraryActor } from './library.types';

@Controller('library')
export class LibraryController {
  constructor(
    private readonly library: LibraryService,
    private readonly sessions: SessionService,
  ) {}

  @Post('resources')
  @UseGuards(AccessTokenGuard)
  async createDraftResource(
    @Body() input: CreateLibraryResourceDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.library.createDraftResource(this.actor(request), input),
      'Library draft created',
    );
  }

  @Post('resources/:resourceId/provenance')
  @UseGuards(AccessTokenGuard)
  async attachProvenance(
    @Param('resourceId', new ParseUUIDPipe({ version: '4' })) resourceId: string,
    @Body() input: AttachLibraryProvenanceDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.library.attachProvenance(this.actor(request), resourceId, input),
      'Library provenance attached',
    );
  }

  @Post('resources/:resourceId/review')
  @UseGuards(AccessTokenGuard)
  async transitionReview(
    @Param('resourceId', new ParseUUIDPipe({ version: '4' })) resourceId: string,
    @Body() input: TransitionLibraryReviewDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.library.transitionReview(
        this.actor(request),
        resourceId,
        input.nextState,
        input.note,
      ),
      'Library review state changed',
    );
  }

  @Get('resources/:resourceId')
  async getPublicResource(
    @Param('resourceId', new ParseUUIDPipe({ version: '4' })) resourceId: string,
  ) {
    const resource = await this.library.getPublicResource(resourceId);
    if (!resource) {
      libraryFailure('LIBRARY_RESOURCE_NOT_FOUND', 'The public library resource was not found', 404);
    }
    return success(resource, 'Library resource');
  }

  @Get('licenses/:licenseKey')
  async getLicense(@Param('licenseKey') licenseKey: string) {
    const license = await this.library.findLicense(licenseKey);
    if (!license || !license.active) {
      libraryFailure('LIBRARY_LICENSE_NOT_FOUND', 'The active library license was not found', 404);
    }
    return success({
      licenseKey: license.licenseKey,
      displayName: license.displayName,
      canonicalUrl: license.canonicalUrl,
      attributionRequired: license.attributionRequired,
      redistributionAllowed: license.redistributionAllowed,
      derivativeConstraints: license.derivativeConstraints,
    }, 'Library license');
  }

  private actor(request: AuthenticatedRequest): LibraryActor {
    const user = request.user?.user;
    if (!user) {
      libraryFailure('AUTH_UNAUTHORIZED', 'You must be signed in to modify the library', 401);
    }
    return { userId: user.id, roles: user.roles };
  }
}
