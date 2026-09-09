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
import type { Request, Response } from 'express';
import { success } from '../common/http/api-response';
import { AuthService } from './auth.service';
import { EmailDto, LoginDto, RegisterDto, ResetPasswordDto, TokenDto } from './auth.dto';
import { AccessTokenGuard, type AuthenticatedRequest } from './guards/access-token.guard';
import { SessionService } from './session/session.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly oauth: OAuthService,
  ) {}

  @Get('providers')
  providers() {
    return success(this.oauth.providers(), 'Các phương thức đăng nhập hiện có');
  }

  @Post('register')
  @HttpCode(201)
  async register(@Body() input: RegisterDto, @Req() request: Request) {
    const data = await this.auth.register(input, clientIp(request));
    return success(data, 'Kiểm tra email để hoàn tất đăng ký');
  }

  @Post('login')
  async login(
    @Body() input: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const data = await this.auth.login(input, response, clientIp(request));
    return success(data, 'Đăng nhập thành công');
  }

  @Post('verify-email')
  async verifyEmail(@Body() input: TokenDto) {
    return success(await this.auth.verifyEmail(input), 'Email đã được xác minh');
  }

  @Post('resend-verification')
  async resendVerification(@Body() input: EmailDto, @Req() request: Request) {
    return success(
      await this.auth.resendVerification(input, clientIp(request)),
      'Nếu tài khoản phù hợp, email xác minh sẽ được gửi lại',
    );
  }

  @Post('forgot-password')
  async forgotPassword(@Body() input: EmailDto, @Req() request: Request) {
    return success(
      await this.auth.forgotPassword(input, clientIp(request)),
      'Nếu tài khoản phù hợp, hướng dẫn đặt lại mật khẩu sẽ được gửi tới email',
    );
  }

  @Post('reset-password')
  async resetPassword(@Body() input: ResetPasswordDto) {
    return success(await this.auth.resetPassword(input), 'Mật khẩu đã được cập nhật');
  }

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

  @Get('oauth/:provider/start')
  async oauthStart(
    @Param('provider') provider: string,
    @Query('mode') mode: string | undefined,
    @Res() response: Response,
  ) {
    const selectedMode = mode === 'register' ? 'register' : 'login';
    const url = await this.oauth.start(provider, selectedMode);
    return response.redirect(url);
  }

  @Post('oauth/:provider/link/start')
  @UseGuards(AccessTokenGuard)
  async oauthLinkStart(
    @Param('provider') provider: string,
    @Req() request: AuthenticatedRequest,
  ) {
    this.sessions.assertCsrfForCookie(request);
    const url = await this.oauth.start(provider, 'link', request.user!.user.id);
    return success({ authorizationUrl: url }, 'Đang mở liên kết tài khoản');
  }

  @Get('oauth/:provider/callback')
  async oauthCallback(
    @Param('provider') provider: string,
    @Query() query: Record<string, unknown>,
    @Res() response: Response,
  ) {
    try {
      await this.oauth.callback(provider, query, response);
      return response.redirect(this.oauth.callbackRedirect('success'));
    } catch (error) {
      return response.redirect(this.oauth.callbackRedirect('error', callbackErrorCode(error)));
    }
  }

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

  @Post('logout-all')
  @UseGuards(AccessTokenGuard)
  async logoutAll(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    this.sessions.assertCsrfForCookie(request);
    return success(await this.auth.logoutAll(request.user!, response), 'Đã đăng xuất khỏi mọi thiết bị');
  }

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
