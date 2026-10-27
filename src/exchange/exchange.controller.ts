import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Delete,
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
import { ExchangeConnectionListDto, ExchangeDiscoveryQueryDto, ExchangePreferenceUpdateDto, ExchangeReportDto } from './exchange.dto';
import { ExchangeService } from './exchange.service';

@ApiTags("Language exchange")
@ApiResponse({ status: 400, description: 'Request validation failed', schema: { $ref: '#/components/schemas/ApiError' } })
@Controller('exchange')
export class ExchangeController {
  constructor(
    private readonly exchanges: ExchangeService,
    private readonly sessions: SessionService,
  ) {}

  @ApiOperation({ summary: "Connections - Language exchange" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get('connections')
  @UseGuards(AccessTokenGuard)
  async connections(@Query() query: ExchangeConnectionListDto, @Req() request: AuthenticatedRequest) {
    return success(await this.exchanges.listConnections(request.user!.user.id,query),'Exchange connections');
  }

  @ApiOperation({ summary: "Own Preferences - Language exchange" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get('preferences')
  @UseGuards(AccessTokenGuard)
  async ownPreferences(@Req() request: AuthenticatedRequest) {
    return success(
      await this.exchanges.getOwnPreferences(request.user!.user.id),
      'Exchange preferences',
    );
  }

  @ApiOperation({ summary: "Update Own Preferences - Language exchange" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Block Status - Language exchange" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiParam({ name: "userId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get('blocks/:userId')
  @UseGuards(AccessTokenGuard)
  async blockStatus(
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.exchanges.getBlockStatus(request.user!.user.id, userId),
      'Exchange block status',
    );
  }

  @ApiOperation({ summary: "Block - Language exchange" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "userId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: HttpStatus.OK, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post('blocks/:userId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async block(
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.exchanges.blockUser(request.user!.user.id, userId),
      'Exchange member blocked',
    );
  }

  @ApiOperation({ summary: "Unblock - Language exchange" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "userId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: HttpStatus.OK, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Delete('blocks/:userId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async unblock(
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.exchanges.unblockUser(request.user!.user.id, userId),
      'Exchange member unblocked',
    );
  }

  @ApiOperation({ summary: "Report - Language exchange" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "userId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: HttpStatus.OK, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post('reports/:userId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async report(
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @Body() input: ExchangeReportDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.exchanges.reportUser(request.user!.user.id, userId, input),
      'Exchange report submitted',
    );
  }

  @ApiOperation({ summary: "Contact Permission - Language exchange" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiParam({ name: "userId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get('contact-permission/:userId')
  @UseGuards(AccessTokenGuard)
  async contactPermission(
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.exchanges.getContactPermission(request.user!.user.id, userId),
      'Exchange contact permission',
    );
  }

  @ApiOperation({ summary: "Public Buddy Preview - Language exchange" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiParam({ name: "userId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Relationship - Language exchange" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiParam({ name: "userId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Request Connection - Language exchange" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "userId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: HttpStatus.OK, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Accept Connection - Language exchange" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "userId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: HttpStatus.OK, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Decline Connection - Language exchange" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "userId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: HttpStatus.OK, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Cancel Connection - Language exchange" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "userId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: HttpStatus.OK, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Disconnect - Language exchange" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "userId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: HttpStatus.OK, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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

  @ApiOperation({ summary: "Discovery - Language exchange" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
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
