import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import type { Response as ExpressResponse } from 'express';
import { InMemoryIdentityRepository } from '../../identity/identity.repository';
import { AccessTokenService } from '../crypto/access-token';
import { SessionService } from '../session/session.service';
import { OAuthService } from './oauth.service';

describe('OAuthService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects a callback after the initiating link session is revoked', async () => {
    const repository = new InMemoryIdentityRepository();
    const config = new ConfigService({
      app: {
        environment: 'test',
        publicAppUrl: 'http://localhost:5173',
        corsOrigins: ['http://localhost:5173'],
      },
      auth: {
        accessSecret: 'local-access-secret-that-is-at-least-32-chars',
        refreshSecret: 'local-refresh-secret-that-is-at-least-32-chars',
        refreshTtlSeconds: 2592000,
        refreshCookieName: 'cdn_refresh',
        csrfCookieName: 'cdn_csrf',
        oauth: {
          google: {
            enabled: true,
            clientId: 'google-client',
            clientSecret: 'google-secret',
            redirectUri: 'http://localhost:3000/api/v1/auth/oauth/google/callback',
            scopes: ['openid', 'email', 'profile'],
            authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
          },
        },
      },
    });
    const user = await repository.createUser({
      email: 'link-owner@example.com',
      displayName: 'Link Owner',
      passwordHash: null,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
    const session = await repository.createSession({
      userId: user.id,
      familyId: 'family-link-owner',
      tokenDigest: 'digest-link-owner',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const sessions = new SessionService(repository, new AccessTokenService(config), config);
    const oauth = new OAuthService(repository, sessions, config);
    const authorizationUrl = await oauth.start('google', 'link', user.id, session.id);
    const state = new URL(authorizationUrl).searchParams.get('state');
    expect(state).toBeTruthy();

    await repository.revokeSession(session.id, new Date());

    await expect(
      oauth.callback(
        'google',
        { state, code: 'provider-code' },
        {} as ExpressResponse,
      ),
    ).rejects.toMatchObject({ code: 'AUTH_SESSION_EXPIRED' });
  });

  it('validates state once and reuses an existing provider identity without email merging', async () => {
    const { repository, oauth } = createFixture();
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ access_token: 'provider-access-token' }))
      .mockResolvedValueOnce(jsonResponse({
        sub: 'google-subject-1',
        email: 'oauth@example.com',
        email_verified: true,
        name: 'OAuth Learner',
      }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'provider-access-token-2' }))
      .mockResolvedValueOnce(jsonResponse({
        sub: 'google-subject-1',
        email: 'changed@example.com',
        email_verified: true,
        name: 'OAuth Learner Updated',
      }));

    const firstStart = await oauth.start('google', 'login');
    const firstState = new URL(firstStart).searchParams.get('state')!;
    const first = await oauth.callback('google', { state: firstState, code: 'first-code' }, response());
    const firstProvider = await repository.findProviderAccount('google', 'google-subject-1');
    expect(first.user.email).toBe('oauth@example.com');
    expect(firstProvider?.userId).toBe(first.user.id);

    const secondStart = await oauth.start('google', 'login');
    const secondState = new URL(secondStart).searchParams.get('state')!;
    const second = await oauth.callback('google', { state: secondState, code: 'second-code' }, response());
    expect(second.user.id).toBe(first.user.id);
    expect((await repository.findProviderAccount('google', 'google-subject-1'))?.providerEmail)
      .toBe('changed@example.com');

    await expect(
      oauth.callback('google', { state: secondState, code: 'second-code' }, response()),
    ).rejects.toMatchObject({ code: 'AUTH_OAUTH_STATE_INVALID' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('rejects a new provider identity when its verified email belongs to a local account', async () => {
    const { repository, oauth } = createFixture();
    await repository.createUser({
      email: 'local-owner@example.com',
      displayName: 'Local Owner',
      passwordHash: null,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
    jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ access_token: 'provider-access-token' }))
      .mockResolvedValueOnce(jsonResponse({
        sub: 'new-google-subject',
        email: 'local-owner@example.com',
        email_verified: true,
      }));
    const start = await oauth.start('google', 'login');
    const state = new URL(start).searchParams.get('state')!;

    await expect(oauth.callback('google', { state, code: 'provider-code' }, response()))
      .rejects.toMatchObject({ code: 'AUTH_ACCOUNT_COLLISION', status: 409 });
  });

  it('rejects missing or unverified provider email claims', async () => {
    const { oauth } = createFixture();
    const fetchMock = jest.spyOn(globalThis, 'fetch');

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'provider-access-token' }))
      .mockResolvedValueOnce(jsonResponse({ sub: 'missing-email-subject' }));
    const missingEmailStart = await oauth.start('google', 'login');
    const missingEmailState = new URL(missingEmailStart).searchParams.get('state')!;
    await expect(oauth.callback('google', { state: missingEmailState, code: 'missing-email' }, response()))
      .rejects.toMatchObject({ code: 'AUTH_OAUTH_EMAIL_UNVERIFIED' });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ access_token: 'provider-access-token-2' }))
      .mockResolvedValueOnce(jsonResponse({
        sub: 'unverified-subject',
        email: 'unverified@example.com',
        email_verified: false,
      }));
    const unverifiedStart = await oauth.start('google', 'login');
    const unverifiedState = new URL(unverifiedStart).searchParams.get('state')!;
    await expect(oauth.callback('google', { state: unverifiedState, code: 'unverified' }, response()))
      .rejects.toMatchObject({ code: 'AUTH_OAUTH_EMAIL_UNVERIFIED' });
  });

  it('does not issue a session for an OAuth identity mapped to a pending user', async () => {
    const { repository, oauth } = createFixture();
    const pending = await repository.createUser({
      email: 'pending-oauth@example.com',
      displayName: 'Pending OAuth',
      passwordHash: null,
      status: 'VERIFICATION_PENDING',
    });
    await repository.createProviderAccount({
      userId: pending.id,
      provider: 'google',
      providerSubject: 'pending-oauth-subject',
      providerEmail: 'pending-oauth@example.com',
      providerDisplayName: 'Pending OAuth',
      providerAvatarUrl: null,
      emailVerified: true,
    });
    jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ access_token: 'provider-access-token' }))
      .mockResolvedValueOnce(jsonResponse({
        sub: 'pending-oauth-subject',
        email: 'pending-oauth@example.com',
        email_verified: true,
      }));
    const start = await oauth.start('google', 'login');
    const state = new URL(start).searchParams.get('state')!;

    let failure: unknown;
    try {
      await oauth.callback('google', { state, code: 'pending-oauth-code' }, response());
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ status: 403 });
    expect((failure as { getResponse: () => unknown }).getResponse())
      .toMatchObject({ code: 'AUTH_EMAIL_VERIFICATION_REQUIRED' });
  });

  it('requires explicit ownership for linking and rejects a provider owned by another user', async () => {
    const { repository, oauth } = createFixture();
    const owner = await repository.createUser({
      email: 'link-owner@example.com',
      displayName: 'Link Owner',
      passwordHash: null,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
    const other = await repository.createUser({
      email: 'other-owner@example.com',
      displayName: 'Other Owner',
      passwordHash: null,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
    const linkSession = await repository.createSession({
      userId: owner.id,
      familyId: 'link-family',
      tokenDigest: 'link-digest',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await repository.createProviderAccount({
      userId: other.id,
      provider: 'google',
      providerSubject: 'owned-by-other',
      providerEmail: 'other-owner@example.com',
      providerDisplayName: 'Other Owner',
      providerAvatarUrl: null,
      emailVerified: true,
    });

    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ access_token: 'provider-access-token' }))
      .mockResolvedValueOnce(jsonResponse({
        sub: 'owned-by-other',
        email: 'different-email@example.com',
        email_verified: true,
      }));
    const start = await oauth.start('google', 'link', owner.id, linkSession.id);
    const state = new URL(start).searchParams.get('state')!;
    await expect(oauth.callback('google', { state, code: 'link-code' }, response()))
      .rejects.toMatchObject({ code: 'AUTH_ACCOUNT_COLLISION', status: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects linking a provider email owned by another local account', async () => {
    const { repository, oauth } = createFixture();
    const owner = await repository.createUser({
      email: 'link-owner@example.com',
      displayName: 'Link Owner',
      passwordHash: null,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
    await repository.createUser({
      email: 'local-owner@example.com',
      displayName: 'Local Owner',
      passwordHash: null,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
    const linkSession = await repository.createSession({
      userId: owner.id,
      familyId: 'link-email-family',
      tokenDigest: 'link-email-digest',
      expiresAt: new Date(Date.now() + 60_000),
    });
    jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ access_token: 'provider-access-token' }))
      .mockResolvedValueOnce(jsonResponse({
        sub: 'new-link-subject',
        email: 'local-owner@example.com',
        email_verified: true,
      }));
    const start = await oauth.start('google', 'link', owner.id, linkSession.id);
    const state = new URL(start).searchParams.get('state')!;

    await expect(oauth.callback('google', { state, code: 'link-email-code' }, response()))
      .rejects.toMatchObject({ code: 'AUTH_ACCOUNT_COLLISION', status: 409 });
    expect(await repository.findProviderAccount('google', 'new-link-subject')).toBeNull();
  });

  it('allows only one owner to win a concurrent provider-link race', async () => {
    const { repository, oauth } = createFixture();
    const firstOwner = await repository.createUser({
      email: 'first-link-owner@example.com',
      displayName: 'First Link Owner',
      passwordHash: null,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
    const secondOwner = await repository.createUser({
      email: 'second-link-owner@example.com',
      displayName: 'Second Link Owner',
      passwordHash: null,
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    });
    const firstSession = await repository.createSession({
      userId: firstOwner.id,
      familyId: 'first-link-family',
      tokenDigest: 'first-link-digest',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const secondSession = await repository.createSession({
      userId: secondOwner.id,
      familyId: 'second-link-family',
      tokenDigest: 'second-link-digest',
      expiresAt: new Date(Date.now() + 60_000),
    });
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        access_token: 'provider-access-token',
        sub: 'concurrent-link-subject',
        email: 'concurrent-provider@example.com',
        email_verified: true,
      }),
    );
    const firstState = new URL(await oauth.start('google', 'link', firstOwner.id, firstSession.id))
      .searchParams.get('state')!;
    const secondState = new URL(await oauth.start('google', 'link', secondOwner.id, secondSession.id))
      .searchParams.get('state')!;

    const results = await Promise.allSettled([
      oauth.callback('google', { state: firstState, code: 'first-link-code' }, response()),
      oauth.callback('google', { state: secondState, code: 'second-link-code' }, response()),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected'))
      .toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: 'AUTH_ACCOUNT_COLLISION' }) })]);
    expect((await repository.findProviderAccount('google', 'concurrent-link-subject'))?.userId)
      .toMatch(/^[0-9a-f-]{36}$/);
  });
});

function createFixture() {
  const repository = new InMemoryIdentityRepository();
  const config = new ConfigService({
    app: {
      environment: 'test',
      publicAppUrl: 'http://localhost:5173',
      corsOrigins: ['http://localhost:5173'],
    },
    auth: {
      accessSecret: 'local-access-secret-that-is-at-least-32-chars',
      accessTtlSeconds: 900,
      refreshSecret: 'local-refresh-secret-that-is-at-least-32-chars',
      refreshTtlSeconds: 2592000,
      refreshCookieName: 'cdn_refresh',
      csrfCookieName: 'cdn_csrf',
      oauth: {
        google: {
          enabled: true,
          clientId: 'google-client',
          clientSecret: 'google-secret',
          redirectUri: 'http://localhost:3000/api/v1/auth/oauth/google/callback',
          scopes: ['openid', 'email', 'profile'],
          authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token',
          userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
        },
      },
    },
  });
  const sessions = new SessionService(repository, new AccessTokenService(config), config);
  return { repository, oauth: new OAuthService(repository, sessions, config) };
}

function jsonResponse(body: Record<string, unknown>, status = 200): globalThis.Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function response(): ExpressResponse {
  return {
    append: jest.fn(),
  } as unknown as ExpressResponse;
}
