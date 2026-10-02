import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { GoogleOAuthAdapter, OAUTH_PROVIDER_REQUEST_TIMEOUT_MS } from './oauth.adapters';

describe('GoogleOAuthAdapter', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('aborts a provider request that exceeds the bounded timeout', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      throw new Error('unreachable');
    });
    const adapter = new GoogleOAuthAdapter({
      enabled: true,
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://app.example.test/api/v1/auth/oauth/google/callback',
      scopes: ['openid', 'email'],
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    });

    const pending = expect(adapter.exchangeCode('provider-code')).rejects.toMatchObject({ code: 'AUTH_OAUTH_FAILED' });
    await jest.advanceTimersByTimeAsync(OAUTH_PROVIDER_REQUEST_TIMEOUT_MS);

    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
});
