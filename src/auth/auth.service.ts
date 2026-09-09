import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { IDENTITY_REPOSITORY } from '../identity/identity.module';
import type { IdentityRepository } from '../identity/identity.repository';
import type { UserRecord } from '../identity/identity.types';
import { isValidEmail, normalizeEmail } from '../identity/identity.types';
import { AuthFailure } from './auth.errors';
import type { EmailProvider } from './email/email.provider';
import { EMAIL_PROVIDER } from './email/email.provider';
import { AuthRateLimiter } from './rate-limit/rate-limiter';
import { PasswordHasher, PasswordPolicyError } from './crypto/password-hasher';
import { createOpaqueToken, digestOpaqueToken } from './crypto/token-crypto';
import { SessionService, type AuthPrincipal, type SessionCredentials } from './session/session.service';
import type { EmailDto, LoginDto, RegisterDto, ResetPasswordDto, TokenDto } from './auth.dto';

const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const DUMMY_PASSWORD_HASH = '$scrypt$N=32768,r=8,p=1$yMskboKN4QdW0KUx8gjyJQ$1Yvz6OhyZp7grCtIWwDi0jA4IX5unGOI9vF3d7rgI1QKiq_lEsQzxUQBPPgjwgpzHjMY5N6EDBJ-I9cg2_qt1g';

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  status: UserRecord['status'];
  emailVerified: boolean;
  roles: UserRecord['roles'];
}

export interface AuthSuccess {
  user: PublicUser;
  accessToken: string;
  expiresIn: number;
}

export interface AuthProvidersResponse {
  providers: Array<{
    name: 'google' | 'facebook' | 'zalo' | 'apple';
    enabled: boolean;
  }>;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(IDENTITY_REPOSITORY) private readonly repository: IdentityRepository,
    @Inject(EMAIL_PROVIDER) private readonly emailProvider: EmailProvider,
    private readonly passwordHasher: PasswordHasher,
    private readonly sessions: SessionService,
    private readonly rateLimiter: AuthRateLimiter,
    private readonly config: ConfigService,
  ) {}

  async register(input: RegisterDto, ip: string): Promise<{ verificationRequired: true }> {
    const email = this.assertEmail(input.email);
    this.consumeRate('register', ip, email, { limit: 5, windowMs: 15 * 60 * 1000 });
    let passwordHash: string;
    try {
      passwordHash = await this.passwordHasher.hash(input.password);
    } catch (error) {
      if (error instanceof PasswordPolicyError) {
        throw new AuthFailure('AUTH_INVALID_PASSWORD', 400, 'Mật khẩu chưa đáp ứng yêu cầu');
      }
      throw error;
    }
    const existing = await this.repository.findUserByEmail(email);
    if (existing) {
      this.audit('registration_duplicate');
      return { verificationRequired: true };
    }
    let user: UserRecord;
    try {
      user = await this.repository.createUser({
        email,
        displayName: input.displayName.trim(),
        passwordHash,
        status: 'VERIFICATION_PENDING',
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'RepositoryConflictError') {
        return { verificationRequired: true };
      }
      throw error;
    }
    await this.sendVerification(user);
    this.audit('registration_created', user.id);
    return { verificationRequired: true };
  }

  async login(input: LoginDto, response: Response, ip: string): Promise<AuthSuccess> {
    const email = this.assertEmail(input.email);
    this.consumeRate('login-ip', ip, undefined, { limit: 30, windowMs: 15 * 60 * 1000 });
    this.consumeRate('login-account', ip, email, { limit: 10, windowMs: 15 * 60 * 1000 });
    const user = await this.repository.findUserByEmail(email);
    const passwordHash = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
    const passwordMatches = await this.passwordHasher.verify(input.password, passwordHash);
    if (!user || !passwordMatches) {
      this.audit('login_failed');
      throw new AuthFailure('AUTH_INVALID_CREDENTIALS', 401, 'Email hoặc mật khẩu không đúng');
    }
    if (user.status === 'DISABLED') {
      this.audit('login_disabled', user.id);
      throw new AuthFailure('AUTH_ACCOUNT_DISABLED', 403, 'Tài khoản đang bị tạm khóa');
    }
    if (user.status !== 'ACTIVE' || !user.emailVerifiedAt) {
      this.audit('login_unverified', user.id);
      throw new AuthFailure('AUTH_EMAIL_VERIFICATION_REQUIRED', 403, 'Vui lòng xác minh email trước khi đăng nhập');
    }
    const session = await this.sessions.issue(user, response);
    this.audit('login_succeeded', user.id);
    return this.withSession(user, session);
  }

  async verifyEmail(input: TokenDto): Promise<{ verified: true }> {
    const token = await this.repository.consumeAuthToken(
      digestOpaqueToken(input.token),
      'EMAIL_VERIFICATION',
      new Date(),
    );
    if (!token) throw new AuthFailure('AUTH_VERIFICATION_INVALID', 400, 'Liên kết xác minh không hợp lệ hoặc đã hết hạn');
    const user = await this.repository.findUserById(token.userId);
    if (!user) throw new AuthFailure('AUTH_VERIFICATION_INVALID', 400, 'Liên kết xác minh không hợp lệ hoặc đã hết hạn');
    await this.repository.updateUser(user.id, {
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
    this.audit('email_verified', user.id);
    return { verified: true };
  }

  async resendVerification(input: EmailDto, ip: string): Promise<{ sent: true }> {
    const email = this.assertEmail(input.email);
    this.consumeRate('verification-resend', ip, email, { limit: 3, windowMs: 15 * 60 * 1000 });
    const user = await this.repository.findUserByEmail(email);
    if (user?.status === 'VERIFICATION_PENDING') await this.sendVerification(user);
    this.audit('verification_resend_requested');
    return { sent: true };
  }

  async forgotPassword(input: EmailDto, ip: string): Promise<{ sent: true }> {
    const email = this.assertEmail(input.email);
    this.consumeRate('password-recovery', ip, email, { limit: 3, windowMs: 15 * 60 * 1000 });
    const user = await this.repository.findUserByEmail(email);
    if (user?.status === 'ACTIVE') {
      await this.repository.revokeAuthTokens(user.id, 'PASSWORD_RESET');
      const token = createOpaqueToken();
      await this.repository.createAuthToken({
        userId: user.id,
        purpose: 'PASSWORD_RESET',
        tokenDigest: digestOpaqueToken(token),
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      });
      await this.emailProvider.sendPasswordReset({
        email: user.email,
        displayName: user.displayName,
        token,
      });
    }
    this.audit('password_recovery_requested');
    return { sent: true };
  }
  async resetPassword(input: ResetPasswordDto): Promise<{ reset: true }> {
    try {
      this.passwordHasher.validate(input.password);
    } catch (error) {
      if (error instanceof PasswordPolicyError) {
        throw new AuthFailure('AUTH_INVALID_PASSWORD', 400, 'Mật khẩu chưa đáp ứng yêu cầu');
      }
      throw error;
    }
    const token = await this.repository.consumeAuthToken(
      digestOpaqueToken(input.token),
      'PASSWORD_RESET',
      new Date(),
    );
    if (!token) throw new AuthFailure('AUTH_RESET_INVALID', 400, 'Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn');
    const user = await this.repository.findUserById(token.userId);
    if (!user || user.status !== 'ACTIVE') {
      throw new AuthFailure('AUTH_RESET_INVALID', 400, 'Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn');
    }
    let passwordHash: string;
    try {
      passwordHash = await this.passwordHasher.hash(input.password);
    } catch (error) {
      if (error instanceof PasswordPolicyError) {
        throw new AuthFailure('AUTH_INVALID_PASSWORD', 400, 'Mật khẩu chưa đáp ứng yêu cầu');
      }
      throw error;
    }
    await this.repository.updateUser(user.id, { passwordHash });
    await Promise.all([
      this.repository.revokeAuthTokens(user.id, 'PASSWORD_RESET'),
      this.repository.revokeAllSessions(user.id, new Date()),
    ]);
    this.audit('password_reset', user.id);
    return { reset: true };
  }

  async refresh(request: import('express').Request, response: Response): Promise<SessionCredentials> {
    return this.sessions.refresh(request, response);
  }

  async logout(principal: AuthPrincipal | null, response: Response): Promise<{ loggedOut: true }> {
    await this.sessions.logout(principal?.claims.sid ?? null, response);
    this.audit('logout', principal?.user.id);
    return { loggedOut: true };
  }

  async logoutAll(principal: AuthPrincipal, response: Response): Promise<{ loggedOut: true }> {
    await this.sessions.logoutAll(principal.user.id, response);
    this.audit('logout_all', principal.user.id);
    return { loggedOut: true };
  }

  providers(): AuthProvidersResponse {
    const oauth = this.config.get<Record<string, { enabled: boolean }>>('auth.oauth') ?? {};
    return {
      providers: (['google', 'facebook', 'zalo', 'apple'] as const).map((name) => ({
        name,
        enabled: oauth[name]?.enabled === true,
      })),
    };
  }

  publicUser(user: UserRecord): PublicUser {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
      emailVerified: Boolean(user.emailVerifiedAt),
      roles: [...user.roles],
    };
  }

  private async sendVerification(user: UserRecord): Promise<void> {
    await this.repository.revokeAuthTokens(user.id, 'EMAIL_VERIFICATION');
    const token = createOpaqueToken();
    await this.repository.createAuthToken({
      userId: user.id,
      purpose: 'EMAIL_VERIFICATION',
      tokenDigest: digestOpaqueToken(token),
      expiresAt: new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS),
    });
    await this.emailProvider.sendVerification({
      email: user.email,
      displayName: user.displayName,
      token,
    });
  }

  private withSession(user: UserRecord, session: SessionCredentials): AuthSuccess {
    const expiresIn = Math.max(1, Math.floor((session.accessTokenExpiresAt.getTime() - Date.now()) / 1000));
    return {
      user: this.publicUser(user),
      accessToken: session.accessToken,
      expiresIn,
    };
  }

  private assertEmail(email: string): string {
    if (typeof email !== 'string') {
      throw new AuthFailure('AUTH_INVALID_EMAIL', 400, 'Vui lòng nhập một email hợp lệ');
    }
    const normalized = normalizeEmail(email);
    if (!isValidEmail(normalized)) {
      throw new AuthFailure('AUTH_INVALID_EMAIL', 400, 'Vui lòng nhập một email hợp lệ');
    }
    return normalized;
  }

  private consumeRate(
    operation: string,
    ip: string,
    email: string | undefined,
    rule: { limit: number; windowMs: number },
  ): void {
    const key = operation + ':' + ip + (email ? ':' + digestOpaqueToken(email).slice(0, 16) : '');
    if (!this.rateLimiter.consume(key, rule)) {
      throw new AuthFailure('AUTH_RATE_LIMITED', 429, 'Bạn thử lại sau ít phút');
    }
  }

  private audit(event: string, userId?: string): void {
    this.logger.log('auth.' + event + (userId ? ' user=' + userId : ''));
  }
}
