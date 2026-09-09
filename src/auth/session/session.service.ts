import { HttpException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { UserRecord } from '../../identity/identity.types';
import { IDENTITY_REPOSITORY } from '../../identity/identity.module';
import type { IdentityRepository, RefreshRotationResult } from '../../identity/identity.repository';
import { AccessTokenService, type AccessTokenClaims } from '../crypto/access-token';
import { createOpaqueToken, digestOpaqueToken } from '../crypto/token-crypto';

export interface AuthPrincipal {
  user: UserRecord;
  claims: AccessTokenClaims;
}

export interface SessionCredentials {
  accessToken: string;
  accessTokenExpiresAt: Date;
  sessionId: string;
}

export class SessionFailure extends HttpException {
  constructor(
    readonly code: string,
    readonly httpStatus = 401,
    message = 'Session is not valid',
  ) {
    super({ code, message }, httpStatus);
    this.name = 'SessionFailure';
  }
}

interface SessionRuntimeConfig {
  refreshSecret: string;
  refreshTtlSeconds: number;
  refreshCookieName: string;
  csrfCookieName: string;
}

interface AppRuntimeConfig {
  environment: 'development' | 'test' | 'production';
  corsOrigins: string[];
}

@Injectable()
export class SessionService {
  constructor(
    @Inject(IDENTITY_REPOSITORY) private readonly repository: IdentityRepository,
    private readonly accessTokens: AccessTokenService,
    private readonly config: ConfigService,
  ) {}

  async issue(user: UserRecord, response: Response, now = new Date()): Promise<SessionCredentials> {
    const auth = this.authConfig();
    const rawRefreshToken = createOpaqueToken();
    const sessionId = randomUUID();
    const familyId = randomUUID();
    const expiresAt = new Date(now.getTime() + auth.refreshTtlSeconds * 1000);
    const session = await this.repository.createSession({
      userId: user.id,
      familyId,
      tokenDigest: digestOpaqueToken(rawRefreshToken, auth.refreshSecret),
      expiresAt,
    });
    const access = this.accessTokens.issue(user.id, session.id, user.roles, now);
    this.setSessionCookies(response, rawRefreshToken, now);
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      sessionId: session.id,
    };
  }

  async refresh(request: Request, response: Response, now = new Date()): Promise<SessionCredentials> {
    this.assertCookieRequest(request);
    const rawRefreshToken = readCookie(request, this.authConfig().refreshCookieName);
    if (!rawRefreshToken) throw new SessionFailure('AUTH_SESSION_EXPIRED');
    const auth = this.authConfig();
    const digest = digestOpaqueToken(rawRefreshToken, auth.refreshSecret);
    const current = await this.repository.findSessionByDigest(digest);
    if (!current) {
      this.clearSessionCookies(response);
      throw new SessionFailure('AUTH_SESSION_EXPIRED');
    }
    const replacementRawToken = createOpaqueToken();
    const replacement: RefreshRotationResult = await this.repository.rotateSession({
      oldDigest: digest,
      replacement: {
        userId: current.userId,
        familyId: current.familyId,
        tokenDigest: digestOpaqueToken(replacementRawToken, auth.refreshSecret),
        expiresAt: new Date(now.getTime() + auth.refreshTtlSeconds * 1000),
      },
      now,
    });
    if (replacement.status !== 'rotated') {
      this.clearSessionCookies(response);
      if (replacement.status === 'replay') {
        throw new SessionFailure('AUTH_REFRESH_REUSE_DETECTED', 401, 'Refresh session reuse was detected');
      }
      throw new SessionFailure('AUTH_SESSION_EXPIRED');
    }
    const user = await this.repository.findUserById(current.userId);
    if (!user || user.status !== 'ACTIVE') {
      await this.repository.revokeSessionFamily(current.familyId, now);
      this.clearSessionCookies(response);
      throw new SessionFailure(user?.status === 'DISABLED' ? 'AUTH_ACCOUNT_DISABLED' : 'AUTH_SESSION_EXPIRED');
    }
    const access = this.accessTokens.issue(user.id, replacement.session.id, user.roles, now);
    this.setSessionCookies(response, replacementRawToken, now);
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      sessionId: replacement.session.id,
    };
  }

  async authenticate(accessToken: string): Promise<AuthPrincipal> {
    const claims = this.accessTokens.verify(accessToken);
    if (!claims) throw new SessionFailure('AUTH_SESSION_EXPIRED');
    const [session, user] = await Promise.all([
      this.repository.findSessionById(claims.sid),
      this.repository.findUserById(claims.sub),
    ]);
    if (
      !session ||
      session.userId !== claims.sub ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now() ||
      !user ||
      user.status !== 'ACTIVE'
    ) {
      throw new SessionFailure(user?.status === 'DISABLED' ? 'AUTH_ACCOUNT_DISABLED' : 'AUTH_SESSION_EXPIRED');
    }
    return { user, claims };
  }

  async logout(sessionId: string | null, response: Response, now = new Date()): Promise<void> {
    if (sessionId) await this.repository.revokeSession(sessionId, now);
    this.clearSessionCookies(response);
  }

  async logoutFromRequest(request: Request, response: Response, now = new Date()): Promise<void> {
    const rawRefreshToken = readCookie(request, this.authConfig().refreshCookieName);
    const session = rawRefreshToken
      ? await this.repository.findSessionByDigest(digestOpaqueToken(rawRefreshToken, this.authConfig().refreshSecret))
      : null;
    await this.logout(session?.id ?? null, response, now);
  }

  async logoutAll(userId: string, response: Response, now = new Date()): Promise<void> {
    await this.repository.revokeAllSessions(userId, now);
    this.clearSessionCookies(response);
  }

  csrfToken(request: Request): string | null {
    return readCookie(request, this.authConfig().csrfCookieName);
  }

  assertCsrfForCookie(request: Request): void {
    if (readCookie(request, this.authConfig().refreshCookieName)) {
      this.assertCookieRequest(request);
    }
  }

  private assertCookieRequest(request: Request): void {
    const app = this.config.get<AppRuntimeConfig>('app');
    const origin = request.headers.origin;
    if (origin && (!app?.corsOrigins || !app.corsOrigins.includes(origin))) {
      throw new SessionFailure('AUTH_CSRF_INVALID', 403, 'Request origin is not allowed');
    }
    const csrfCookie = readCookie(request, this.authConfig().csrfCookieName);
    const csrfHeader = request.headers['x-csrf-token'];
    const headerValue = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;
    if (!csrfCookie || typeof headerValue !== 'string') {
      throw new SessionFailure('AUTH_CSRF_INVALID', 403, 'CSRF validation failed');
    }
    const expected = Buffer.from(csrfCookie);
    const actual = Buffer.from(headerValue);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new SessionFailure('AUTH_CSRF_INVALID', 403, 'CSRF validation failed');
    }
  }

  private setSessionCookies(response: Response, refreshToken: string, now: Date): void {
    const auth = this.authConfig();
    const csrfToken = createOpaqueToken();
    const secure = this.config.get<AppRuntimeConfig>('app')?.environment === 'production';
    const maxAge = auth.refreshTtlSeconds;
    response.append(
      'Set-Cookie',
      serializeCookie(auth.refreshCookieName, refreshToken, {
        httpOnly: true,
        secure,
        sameSite: 'Lax',
        path: '/api/v1/auth',
        maxAge,
      }),
    );
    response.append(
      'Set-Cookie',
      serializeCookie(auth.csrfCookieName, csrfToken, {
        httpOnly: false,
        secure,
        sameSite: 'Lax',
        path: '/',
        maxAge,
      }),
    );
    void now;
  }

  private clearSessionCookies(response: Response): void {
    const auth = this.authConfig();
    const secure = this.config.get<AppRuntimeConfig>('app')?.environment === 'production';
    response.append(
      'Set-Cookie',
      serializeCookie(auth.refreshCookieName, '', {
        httpOnly: true,
        secure,
        sameSite: 'Lax',
        path: '/api/v1/auth',
        maxAge: 0,
      }),
    );
    response.append(
      'Set-Cookie',
      serializeCookie(auth.csrfCookieName, '', {
        httpOnly: false,
        secure,
        sameSite: 'Lax',
        path: '/',
        maxAge: 0,
      }),
    );
  }

  private authConfig(): SessionRuntimeConfig {
    const auth = this.config.get<SessionRuntimeConfig>('auth');
    if (!auth?.refreshSecret || !auth.refreshTtlSeconds || !auth.refreshCookieName || !auth.csrfCookieName) {
      throw new Error('Auth session configuration is unavailable');
    }
    return auth;
  }
}

function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.cookie;
  if (!raw) return null;
  for (const segment of raw.split(';')) {
    const separator = segment.indexOf('=');
    if (separator < 0) continue;
    const key = segment.slice(0, separator).trim();
    if (key !== name) continue;
    const value = segment.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Lax';
    path: string;
    maxAge: number;
  },
): string {
  const attributes = [
    name + '=' + encodeURIComponent(value),
    'Path=' + options.path,
    'Max-Age=' + options.maxAge,
    'SameSite=' + options.sameSite,
  ];
  if (options.httpOnly) attributes.push('HttpOnly');
  if (options.secure) attributes.push('Secure');
  return attributes.join('; ');
}
