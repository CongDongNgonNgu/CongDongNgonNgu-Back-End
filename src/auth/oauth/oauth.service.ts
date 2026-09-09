import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { IDENTITY_REPOSITORY } from '../../identity/identity.module';
import type { IdentityRepository } from '../../identity/identity.repository';
import type { OAuthProviderName, UserRecord } from '../../identity/identity.types';
import { isValidEmail, normalizeEmail } from '../../identity/identity.types';
import { AuthFailure } from '../auth.errors';
import { createOpaqueToken, digestOpaqueToken } from '../crypto/token-crypto';
import { SessionService, type SessionCredentials } from '../session/session.service';
import { DisabledOAuthAdapter, GoogleOAuthAdapter } from './oauth.adapters';
import { OAuthFailure } from './oauth.errors';
import type { OAuthIdentity, OAuthProviderAdapter, OAuthProviderRuntimeConfig } from './oauth.types';

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const PROVIDERS = ['google', 'facebook', 'zalo', 'apple'] as const;

interface OAuthAppConfig {
  publicAppUrl: string;
}

@Injectable()
export class OAuthService {
  constructor(
    @Inject(IDENTITY_REPOSITORY) private readonly repository: IdentityRepository,
    private readonly sessions: SessionService,
    private readonly config: ConfigService,
  ) {}

  providers(): { providers: Array<{ name: OAuthProviderName; enabled: boolean }> } {
    return {
      providers: PROVIDERS.map((name) => ({
        name,
        enabled: name === 'google' && this.adapter(name).enabled,
      })),
    };
  }

  async start(
    providerName: string,
    mode: 'login' | 'register' | 'link',
    userId: string | null = null,
  ): Promise<string> {
    const provider = this.readProvider(providerName);
    if (mode === 'link' && !userId) {
      throw new AuthFailure('AUTH_UNAUTHORIZED', 401, 'Bạn cần đăng nhập để liên kết tài khoản');
    }
    const adapter = this.adapter(provider);
    if (!adapter.enabled) {
      throw new OAuthFailure(
        this.configured(provider) ? 'AUTH_PROVIDER_UNAVAILABLE' : 'AUTH_PROVIDER_DISABLED',
        503,
        'Phương thức đăng nhập này hiện chưa khả dụng',
      );
    }
    const state = createOpaqueToken();
    await this.repository.createOAuthTransaction({
      provider,
      mode,
      userId,
      stateDigest: digestOpaqueToken(state),
      expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
    });
    return adapter.getAuthorizationUrl(state);
  }

  async callback(
    providerName: string,
    query: Record<string, unknown>,
    response: Response,
  ): Promise<{ user: UserRecord; session: SessionCredentials }> {
    const provider = this.readProvider(providerName);
    const adapter = this.adapter(provider);
    if (!adapter.enabled) {
      throw new OAuthFailure(
        this.configured(provider) ? 'AUTH_PROVIDER_UNAVAILABLE' : 'AUTH_PROVIDER_DISABLED',
        503,
        'Phương thức đăng nhập này hiện chưa khả dụng',
      );
    }
    if (typeof query.error === 'string') {
      throw new OAuthFailure('AUTH_OAUTH_FAILED', 400, 'Bạn đã hủy hoặc từ chối đăng nhập');
    }
    const state = readString(query.state);
    const code = readString(query.code);
    if (!state || !code) {
      throw new OAuthFailure('AUTH_OAUTH_STATE_INVALID', 400, 'Phiên OAuth không hợp lệ');
    }
    const transaction = await this.repository.consumeOAuthTransaction(
      digestOpaqueToken(state),
      new Date(),
    );
    if (!transaction || transaction.provider !== provider) {
      throw new OAuthFailure('AUTH_OAUTH_STATE_INVALID', 400, 'Phiên OAuth không hợp lệ hoặc đã hết hạn');
    }
    const identity = await adapter.exchangeCode(code);
    this.assertIdentity(identity);
    const user = await this.resolveUser(transaction.mode, transaction.userId, identity);
    const session = await this.sessions.issue(user, response);
    return { user, session };
  }

  callbackRedirect(status: 'success' | 'error', code?: string): string {
    const app = this.config.get<OAuthAppConfig>('app');
    const url = new URL('/auth/callback', app?.publicAppUrl ?? 'http://localhost:5173');
    url.searchParams.set('status', status);
    if (code) url.searchParams.set('code', code);
    return url.toString();
  }

  private async resolveUser(
    mode: 'login' | 'register' | 'link',
    boundUserId: string | null,
    identity: OAuthIdentity,
  ): Promise<UserRecord> {
    const existingProvider = await this.repository.findProviderAccount(identity.provider, identity.subject);
    if (mode === 'link') {
      if (!boundUserId) throw new AuthFailure('AUTH_UNAUTHORIZED', 401, 'Bạn cần đăng nhập để liên kết tài khoản');
      const owner = await this.repository.findUserById(boundUserId);
      if (!owner || owner.status !== 'ACTIVE') {
        throw new AuthFailure('AUTH_SESSION_EXPIRED', 401, 'Phiên liên kết đã hết hạn');
      }
      if (existingProvider && existingProvider.userId !== owner.id) {
        throw new OAuthFailure('AUTH_ACCOUNT_COLLISION', 409, 'Tài khoản này đã được liên kết với người dùng khác');
      }
      if (existingProvider) {
        await this.repository.updateProviderAccount(existingProvider.id, providerMetadata(identity));
        return owner;
      }
      try {
        await this.repository.createProviderAccount({
          userId: owner.id,
          ...providerMetadata(identity),
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'RepositoryConflictError') {
          throw new OAuthFailure('AUTH_ACCOUNT_COLLISION', 409, 'Tài khoản này vừa được liên kết ở nơi khác');
        }
        throw error;
      }
      return owner;
    }

    if (existingProvider) {
      const user = await this.repository.findUserById(existingProvider.userId);
      if (!user) throw new OAuthFailure('AUTH_OAUTH_FAILED', 400, 'Tài khoản OAuth không còn tồn tại');
      if (user.status === 'DISABLED') {
        throw new AuthFailure('AUTH_ACCOUNT_DISABLED', 403, 'Tài khoản đang bị tạm khóa');
      }
      await this.repository.updateProviderAccount(existingProvider.id, providerMetadata(identity));
      return user;
    }

    const email = normalizeEmail(identity.email!);
    const existingEmail = await this.repository.findUserByEmail(email);
    if (existingEmail) {
      throw new OAuthFailure(
        'AUTH_ACCOUNT_COLLISION',
        409,
        'Email này đã có tài khoản. Hãy đăng nhập rồi liên kết Google trong phần tài khoản',
      );
    }
    let user: UserRecord;
    try {
      user = await this.repository.createUser({
        email,
        displayName: identity.displayName?.trim() || 'Thành viên mới',
        passwordHash: null,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      });
      await this.repository.createProviderAccount({
        userId: user.id,
        ...providerMetadata(identity),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'RepositoryConflictError') {
        throw new OAuthFailure('AUTH_ACCOUNT_COLLISION', 409, 'Tài khoản OAuth vừa phát sinh xung đột');
      }
      throw error;
    }
    return user;
  }

  private assertIdentity(identity: OAuthIdentity): void {
    if (
      !identity.subject ||
      !identity.email ||
      !isValidEmail(normalizeEmail(identity.email)) ||
      !identity.emailVerified
    ) {
      throw new OAuthFailure(
        'AUTH_OAUTH_EMAIL_UNVERIFIED',
        400,
        'Nhà cung cấp chưa xác minh email cho tài khoản này',
      );
    }
  }

  private adapter(provider: OAuthProviderName): OAuthProviderAdapter {
    const config = this.config.get<Record<string, OAuthProviderRuntimeConfig>>('auth.oauth')?.[provider];
    if (provider === 'google' && config?.enabled && config.clientId && config.clientSecret && config.redirectUri) {
      return new GoogleOAuthAdapter(config);
    }
    return new DisabledOAuthAdapter(provider);
  }

  private configured(provider: OAuthProviderName): boolean {
    return this.config.get<Record<string, OAuthProviderRuntimeConfig>>('auth.oauth')?.[provider]?.enabled === true;
  }

  private readProvider(value: string): OAuthProviderName {
    if (!PROVIDERS.includes(value as OAuthProviderName)) {
      throw new OAuthFailure('AUTH_PROVIDER_DISABLED', 404, 'Nhà cung cấp không được hỗ trợ');
    }
    return value as OAuthProviderName;
  }
}

function providerMetadata(identity: OAuthIdentity) {
  return {
    provider: identity.provider,
    providerSubject: identity.subject,
    providerEmail: normalizeEmail(identity.email!),
    providerDisplayName: identity.displayName,
    providerAvatarUrl: identity.avatarUrl,
    emailVerified: identity.emailVerified,
  };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
