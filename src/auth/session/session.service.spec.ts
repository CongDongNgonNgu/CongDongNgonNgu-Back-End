import { describe, expect, it } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { InMemoryIdentityRepository } from '../../identity/identity.repository';
import type { UserRecord } from '../../identity/identity.types';
import { AccessTokenService } from '../crypto/access-token';
import { SessionService } from './session.service';

const NOW = new Date('2026-09-09T00:00:00.000Z');

describe('SessionService', () => {
  it('rotates refresh credentials and revokes the family on replay', async () => {
    const repository = new InMemoryIdentityRepository();
    const sessions = createSessionService(repository);
    const user = await createUser(repository);
    const issuedResponse = response();
    const issued = await sessions.issue(user, issuedResponse, NOW);
    const oldRefresh = cookieValue(issuedResponse.cookies, 'cdn_refresh');
    const csrf = cookieValue(issuedResponse.cookies, 'cdn_csrf');

    const rotatedResponse = response();
    const rotated = await sessions.refresh(
      cookieRequest(oldRefresh, csrf),
      rotatedResponse,
      new Date(NOW.getTime() + 1000),
    );
    expect(rotated.accessToken).not.toBe(issued.accessToken);
    expect(cookieValue(rotatedResponse.cookies, 'cdn_refresh')).not.toBe(oldRefresh);

    await expect(
      sessions.refresh(cookieRequest(oldRefresh, csrf), response(), new Date(NOW.getTime() + 2000)),
    ).rejects.toMatchObject({ code: 'AUTH_REFRESH_REUSE_DETECTED' });

    const replacement = await repository.findSessionById(rotated.sessionId);
    expect(replacement?.revokedAt).not.toBeNull();
  });

  it('requires a matching origin and double-submit CSRF token for cookie refresh', async () => {
    const repository = new InMemoryIdentityRepository();
    const sessions = createSessionService(repository);
    const user = await createUser(repository);
    const issuedResponse = response();
    await sessions.issue(user, issuedResponse, NOW);
    const refresh = cookieValue(issuedResponse.cookies, 'cdn_refresh');
    const csrf = cookieValue(issuedResponse.cookies, 'cdn_csrf');

    await expect(
      sessions.refresh(
        cookieRequest(refresh, csrf, 'wrong-csrf'),
        response(),
        new Date(NOW.getTime() + 1000),
      ),
    ).rejects.toMatchObject({ code: 'AUTH_CSRF_INVALID', httpStatus: 403 });

    await expect(
      sessions.refresh(
        {
          headers: {
            cookie: 'cdn_refresh=' + refresh + '; cdn_csrf=' + csrf,
            origin: 'https://attacker.example',
          },
        } as Request,
        response(),
        new Date(NOW.getTime() + 1000),
      ),
    ).rejects.toMatchObject({ code: 'AUTH_CSRF_INVALID', httpStatus: 403 });
  });

  it('rejects an expired access token even when its signature is valid', async () => {
    const config = createConfig();
    const accessTokens = new AccessTokenService(config);
    const issued = accessTokens.issue('user-id', 'session-id', ['MEMBER'], NOW);

    expect(accessTokens.verify(issued.token, new Date(NOW.getTime() + 899_000))).not.toBeNull();
    expect(accessTokens.verify(issued.token, issued.expiresAt)).toBeNull();
  });
});

function createSessionService(repository: InMemoryIdentityRepository): SessionService {
  const config = createConfig();
  return new SessionService(repository, new AccessTokenService(config), config);
}

function createConfig(): ConfigService {
  return new ConfigService({
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
}

async function createUser(repository: InMemoryIdentityRepository): Promise<UserRecord> {
  return repository.createUser({
    email: 'session-user@example.com',
    displayName: 'Session User',
    passwordHash: null,
    status: 'ACTIVE',
    emailVerifiedAt: NOW,
  });
}

function response(): Response & { cookies: string[] } {
  const cookies: string[] = [];
  return {
    cookies,
    append(name: string, value: string) {
      if (name === 'Set-Cookie') cookies.push(value);
    },
  } as unknown as Response & { cookies: string[] };
}

function cookieRequest(refresh: string, csrf: string, headerCsrf = csrf): Request {
  return {
    headers: {
      cookie: 'cdn_refresh=' + refresh + '; cdn_csrf=' + csrf,
      origin: 'http://localhost:5173',
      'x-csrf-token': headerCsrf,
    },
  } as unknown as Request;
}

function cookieValue(cookies: string[], name: string): string {
  const cookie = cookies.find((item) => item.startsWith(name + '='));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1).split(';')[0]) : '';
}
