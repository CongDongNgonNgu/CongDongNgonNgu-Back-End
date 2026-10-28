import { ApiBearerAuth, ApiCookieAuth, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { OAuthService } from './oauth/oauth.service';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { success } from '../common/http/api-response';
import { AuthService } from './auth.service';
import { EmailDto, LoginDto, RegisterDto, ResetPasswordDto, TokenDto } from './auth.dto';
import { AccessTokenGuard, type AuthenticatedRequest } from './guards/access-token.guard';
import {
  appendOAuthStateCookieFromAuthorizationUrl,
  assertOAuthStateCookie,
  clearOAuthStateCookie,
} from './oauth/oauth-state-cookie';
import { SessionService } from './session/session.service';

@ApiTags("Authentication")
@ApiResponse({ status: 400, description: 'Request validation failed', schema: { $ref: '#/components/schemas/ApiError' } })
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly oauth: OAuthService,
    private readonly config: ConfigService,
  ) {}

  @ApiOperation({ summary: "Providers - Authentication" })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get('providers')
  providers() {
    return success(this.oauth.providers(), 'Các phương thức đăng nhập hiện có');
  }

  @ApiOperation({ summary: "Register - Authentication" })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post('register')
  @HttpCode(201)
  async register(@Body() input: RegisterDto, @Req() request: Request) {
    const data = await this.auth.register(input, clientIp(request));
    return success(data, 'Kiểm tra email để hoàn tất đăng ký');
  }

  @ApiOperation({ summary: "Login - Authentication" })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @ApiResponse({ status: 401, description: 'Invalid credentials', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Account disabled or email verification required', schema: { $ref: '#/components/schemas/ApiError' } })
  @Post('login')
  async login(
    @Body() input: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const data = await this.auth.login(input, response, clientIp(request));
    return success(data, 'Đăng nhập thành công');
  }

  @ApiOperation({ summary: "Verify Email - Authentication" })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post('verify-email')
  async verifyEmail(@Body() input: TokenDto) {
    return success(await this.auth.verifyEmail(input), 'Email đã được xác minh');
  }

  @ApiOperation({ summary: "Resend Verification - Authentication" })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post('resend-verification')
  async resendVerification(@Body() input: EmailDto, @Req() request: Request) {
    return success(
      await this.auth.resendVerification(input, clientIp(request)),
      'Nếu tài khoản phù hợp, email xác minh sẽ được gửi lại',
    );
  }

  @ApiOperation({ summary: "Forgot Password - Authentication" })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post('forgot-password')
  async forgotPassword(@Body() input: EmailDto, @Req() request: Request) {
    return success(
      await this.auth.forgotPassword(input, clientIp(request)),
      'Nếu tài khoản phù hợp, hướng dẫn đặt lại mật khẩu sẽ được gửi tới email',
    );
  }

  @ApiOperation({ summary: "Reset Password - Authentication" })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post('reset-password')
  async resetPassword(@Body() input: ResetPasswordDto) {
    return success(await this.auth.resetPassword(input), 'Mật khẩu đã được cập nhật');
  }

  @ApiOperation({ summary: 'Deliver the API-host CSRF token to an allowed frontend origin' })
  @Get('csrf')
  csrf(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Pragma', 'no-cache');
    return success({ csrfToken: this.sessions.csrfToken(request) }, 'CSRF token');
  }

  @ApiOperation({ summary: "Refresh - Authentication" })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @ApiCookieAuth('refresh')
  @ApiHeader({ name: 'X-CSRF-Token', required: true, description: 'Must match the CSRF cookie accompanying the refresh-session cookie', schema: { type: 'string' } })
  @ApiResponse({ status: 401, description: 'Refresh session is missing, invalid or expired', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Cookie origin or CSRF validation failed', schema: { $ref: '#/components/schemas/ApiError' } })
  @Post('refresh')
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const session = await this.auth.refresh(request, response);
    return success({
      accessToken: session.accessToken,
      expiresIn: Math.max(1, Math.floor((session.accessTokenExpiresAt.getTime() - Date.now()) / 1000)),
    }, 'Phiên đăng nhập đã được gia hạn');
  }

  @ApiOperation({ summary: "Oauth Start - Authentication" })
  @ApiParam({ name: "provider", required: true, schema: { type: 'string' } })
  @ApiQuery({ name: "mode", required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 302, description: 'OAuth redirect', headers: { Location: { schema: { type: 'string', format: 'uri' } } } })
  @Get('oauth/:provider/start')
  async oauthStart(
    @Param('provider') provider: string,
    @Query('mode') mode: string | undefined,
    @Res() response: Response,
  ) {
    const selectedMode = mode === 'register' ? 'register' : 'login';
    const url = await this.oauth.start(provider, selectedMode);
    appendOAuthStateCookieFromAuthorizationUrl(response, url, this.isProduction());
    return response.redirect(url);
  }

  @ApiOperation({ summary: "Oauth Link Start - Authentication" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiParam({ name: "provider", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post('oauth/:provider/link/start')
  @UseGuards(AccessTokenGuard)
  async oauthLinkStart(
    @Param('provider') provider: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.sessions.assertCsrfForCookie(request);
    const url = await this.oauth.start(provider, 'link', request.user!.user.id, request.user!.claims.sid);
    appendOAuthStateCookieFromAuthorizationUrl(response, url, this.isProduction());
    return success({ authorizationUrl: url }, 'Đang mở liên kết tài khoản');
  }

  @ApiOperation({ summary: "Oauth Callback - Authentication" })
  @ApiParam({ name: "provider", required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 302, description: 'OAuth redirect', headers: { Location: { schema: { type: 'string', format: 'uri' } } } })
  @Get('oauth/:provider/callback')
  async oauthCallback(
    @Param('provider') provider: string,
    @Query() query: Record<string, unknown>,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    let redirectUrl: string;
    try {
      assertOAuthStateCookie(request, query);
      await this.oauth.callback(provider, query, response);
      redirectUrl = this.oauth.callbackRedirect('success');
    } catch (error) {
      redirectUrl = this.oauth.callbackRedirect('error', callbackErrorCode(error));
    }
    clearOAuthStateCookie(response, this.isProduction());
    return response.redirect(redirectUrl);
  }

  private isProduction(): boolean {
    return this.config.get<string>('app.environment') === 'production';
  }

  @ApiOperation({ summary: 'Logout - Authentication', security: [{}, { bearer: [] }, { refresh: [] }], description: 'Revokes an available session and clears authentication cookies; anonymous logout remains supported' })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post('logout')
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.sessions.assertCsrfForCookie(request);
    const principal = await optionalPrincipal(request, this.sessions);
    if (!principal) {
      await this.sessions.logoutFromRequest(request, response);
      return success({ loggedOut: true }, 'Đã đăng xuất');
    }
    return success(await this.auth.logout(principal, response), 'Đã đăng xuất');
  }

  @ApiOperation({ summary: "Logout All - Authentication" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 403, description: 'Authorization or CSRF policy rejected the request', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required with the refresh-session cookie; must match the CSRF cookie', schema: { type: 'string' } })
  @ApiResponse({ status: 201, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Post('logout-all')
  @UseGuards(AccessTokenGuard)
  async logoutAll(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(await this.auth.logoutAll(request.user!, response), 'Đã đăng xuất khỏi mọi thiết bị');
  }

  @ApiOperation({ summary: "Me - Authentication" })
  @ApiBearerAuth('bearer')
  @ApiResponse({ status: 401, description: 'Valid application access token required', schema: { $ref: '#/components/schemas/ApiError' } })
  @ApiResponse({ status: 200, description: 'Successful response', schema: { $ref: '#/components/schemas/ApiSuccess' } })
  @Get('me')
  @UseGuards(AccessTokenGuard)
  me(@Req() request: AuthenticatedRequest) {
    return success(this.auth.publicUser(request.user!.user), 'Thông tin tài khoản');
  }
}

function clientIp(request: Request): string {
  return request.ip || request.socket.remoteAddress || 'unknown';
}

function callbackErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return code;
  }
  return 'AUTH_OAUTH_FAILED';
}

async function optionalPrincipal(
  request: AuthenticatedRequest,
  sessions: SessionService,
) {
  if (request.user) return request.user;
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Bearer ')) return null;
  try {
    return await sessions.authenticate(authorization.slice('Bearer '.length).trim());
  } catch {
    return null;
  }
}
