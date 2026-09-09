import { describe, expect, it } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { AuthRateLimiter } from './rate-limit/rate-limiter';
import { AccessTokenService } from './crypto/access-token';
import { PasswordHasher } from './crypto/password-hasher';
import { AuthService } from './auth.service';
import { MemoryEmailProvider } from './email/email.provider';
import { SessionService } from './session/session.service';
import { InMemoryIdentityRepository } from '../identity/identity.repository';
import { createOpaqueToken, digestOpaqueToken } from './crypto/token-crypto';
import type { ResetPasswordDto } from './auth.dto';

describe('AuthService', () => {
  it('keeps a recovery token usable when the replacement password is invalid', async () => {
    const repository = new InMemoryIdentityRepository();
    const config = new ConfigService({
      app: {
        environment: 'test',
        corsOrigins: ['http://localhost:5173'],
      },
      auth: {
        accessSecret: 'local-access-secret-that-is-at-least-32-chars',
        accessTtlSeconds: 900,
        refreshSecret: 'local-refresh-secret-that-is-at-least-32-chars',
        refreshTtlSeconds: 2592000,
        refreshCookieName: 'cdn_refresh',
        csrfCookieName: 'cdn_csrf',
      },
    });
    const auth = new AuthService(
      repository,
      new MemoryEmailProvider(),
      new PasswordHasher(),
      new SessionService(repository, new AccessTokenService(config), config),
      new AuthRateLimiter(),
      config,
    );
    const user = await repository.createUser({
      email: 'recovery-token@example.com',
      displayName: 'Recovery Token',
      passwordHash: null,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
    const token = createOpaqueToken();
    await repository.createAuthToken({
      userId: user.id,
      purpose: 'PASSWORD_RESET',
      tokenDigest: digestOpaqueToken(token),
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(auth.resetPassword({ token, password: 'short' } as ResetPasswordDto))
      .rejects.toThrow();
    await expect(auth.resetPassword({ token, password: 'Valid recovery password 2026' } as ResetPasswordDto))
      .resolves.toEqual({ reset: true });
  });
});
