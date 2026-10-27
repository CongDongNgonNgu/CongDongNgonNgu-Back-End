import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { success } from '../common/http/api-response';
import { AccessTokenGuard, type AuthenticatedRequest } from '../auth/guards/access-token.guard';
import { SessionService } from '../auth/session/session.service';
import { CommunityService } from './community.service';
import {
  CreateCommentDto,
  CreatePostDto,
  ListCommentsQueryDto,
  ListPostsQueryDto,
  ReactionDto,
  ReportDto,
  SavedPostsQueryDto,
  UpdateCommentDto,
  UpdatePostDto,
} from './community.dto';
import { OptionalAccessTokenGuard } from './optional-access-token.guard';

@ApiTags("Community")
@ApiResponse({ status: 400, description: 'Request validation failed', schema: { $ref: '#/components/schemas/ApiError' } })
@Controller('community')
export class CommunityController {
  constructor(
    private readonly community: CommunityService,
    private readonly sessions: SessionService,
  ) {}

  @ApiOperation({ summary: "Create Post - Community" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post('posts')
  @UseGuards(AccessTokenGuard)
  async createPost(
    @Body() input: CreatePostDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.community.createPost(request.user!.user.id, input),
      'Post created',
    );
  }

  @ApiOperation({ summary: "List Posts - Community", security: [{}, { bearer: [] }] })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get('posts')
  @UseGuards(OptionalAccessTokenGuard)
  async listPosts(
    @Query() query: ListPostsQueryDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.community.listPosts(query, request.user?.user.id ?? null),
      'Community posts',
    );
  }

  @ApiOperation({ summary: "Get Share Link - Community", security: [{}, { bearer: [] }] })
  @ApiParam({ name: "postId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get('posts/:postId/share')
  @UseGuards(OptionalAccessTokenGuard)
  async getShareLink(
    @Param('postId', new ParseUUIDPipe({ version: '4' })) postId: string,
  ) {
    return success(
      await this.community.getShareLink(postId),
      'Community share link',
    );
  }

  @ApiOperation({ summary: "Get Post - Community", security: [{}, { bearer: [] }] })
  @ApiParam({ name: "postId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get('posts/:postId')
  @UseGuards(OptionalAccessTokenGuard)
  async getPost(
    @Param('postId', new ParseUUIDPipe({ version: '4' })) postId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.community.getPost(postId, request.user?.user.id ?? null),
      'Community post',
    );
  }

  @ApiOperation({ summary: "Update Post - Community" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "postId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Patch('posts/:postId')
  @UseGuards(AccessTokenGuard)
  async updatePost(
    @Param('postId', new ParseUUIDPipe({ version: '4' })) postId: string,
    @Body() input: UpdatePostDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.community.updatePost(postId, request.user!.user.id, input),
      'Post updated',
    );
  }

  @ApiOperation({ summary: "Delete Post - Community" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "postId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Delete('posts/:postId')
  @UseGuards(AccessTokenGuard)
  async deletePost(
    @Param('postId', new ParseUUIDPipe({ version: '4' })) postId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.community.deletePost(postId, request.user!.user.id),
      'Post deleted',
    );
  }

  @ApiOperation({ summary: "Create Comment - Community" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "postId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post('posts/:postId/comments')
  @UseGuards(AccessTokenGuard)
  async createComment(
    @Param('postId', new ParseUUIDPipe({ version: '4' })) postId: string,
    @Body() input: CreateCommentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.community.createComment(postId, request.user!.user.id, input),
      'Comment created',
    );
  }

  @ApiOperation({ summary: "List Comments - Community", security: [{}, { bearer: [] }] })
  @ApiParam({ name: "postId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get('posts/:postId/comments')
  @UseGuards(OptionalAccessTokenGuard)
  async listComments(
    @Param('postId', new ParseUUIDPipe({ version: '4' })) postId: string,
    @Query() query: ListCommentsQueryDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.community.listComments(postId, query, request.user?.user.id ?? null),
      'Community comments',
    );
  }

  @ApiOperation({ summary: "Update Comment - Community" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "commentId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Patch('comments/:commentId')
  @UseGuards(AccessTokenGuard)
  async updateComment(
    @Param('commentId', new ParseUUIDPipe({ version: '4' })) commentId: string,
    @Body() input: UpdateCommentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.community.updateComment(commentId, request.user!.user.id, input),
      'Comment updated',
    );
  }

  @ApiOperation({ summary: "Delete Comment - Community" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "commentId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Delete('comments/:commentId')
  @UseGuards(AccessTokenGuard)
  async deleteComment(
    @Param('commentId', new ParseUUIDPipe({ version: '4' })) commentId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.community.deleteComment(commentId, request.user!.user.id),
      'Comment deleted',
    );
  }

  @ApiOperation({ summary: "Add Reaction - Community" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "postId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post('posts/:postId/reactions')
  @UseGuards(AccessTokenGuard)
  async addReaction(
    @Param('postId', new ParseUUIDPipe({ version: '4' })) postId: string,
    @Body() input: ReactionDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.community.addReaction(postId, request.user!.user.id, input),
      'Reaction added',
    );
  }

  @ApiOperation({ summary: "Remove Reaction - Community" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "postId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: "type", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Delete('posts/:postId/reactions/:type')
  @UseGuards(AccessTokenGuard)
  async removeReaction(
    @Param('postId', new ParseUUIDPipe({ version: '4' })) postId: string,
    @Param('type') type: string,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.community.removeReaction(postId, request.user!.user.id, type),
      'Reaction removed',
    );
  }

  @ApiOperation({ summary: "Save Post - Community" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "postId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post('posts/:postId/save')
  @UseGuards(AccessTokenGuard)
  async savePost(
    @Param('postId', new ParseUUIDPipe({ version: '4' })) postId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.community.savePost(postId, request.user!.user.id),
      'Post saved',
    );
  }

  @ApiOperation({ summary: "Unsave Post - Community" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "postId", required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Delete('posts/:postId/save')
  @UseGuards(AccessTokenGuard)
  async unsavePost(
    @Param('postId', new ParseUUIDPipe({ version: '4' })) postId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.community.unsavePost(postId, request.user!.user.id),
      'Post unsaved',
    );
  }

  @ApiOperation({ summary: "List Saved Posts - Community" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get('saved-posts')
  @UseGuards(AccessTokenGuard)
  async listSavedPosts(
    @Query() query: SavedPostsQueryDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return success(
      await this.community.listSavedPosts(query, request.user!.user.id),
      'Saved community posts',
    );
  }

  @ApiOperation({ summary: "Report - Community" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post('reports')
  @UseGuards(AccessTokenGuard)
  async report(
    @Body() input: ReportDto,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(
      await this.community.report(request.user!.user.id, input),
      'Report submitted',
    );
  }
}
