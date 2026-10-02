import { describe, expect, it } from '@jest/globals';
import {
  OAUTH_STATE_COOKIE,
  appendOAuthStateCookie,
  assertOAuthStateCookie,
  clearOAuthStateCookie,
  readOAuthStateCookie,
  serializeOAuthStateCookie,
} from './oauth-state-cookie';

describe('OAuth browser state cookie', () => {
  it('serializes a short-lived HttpOnly SameSite cookie scoped to the OAuth callback', () => {
    const serialized = serializeOAuthStateCookie('opaque-state', false);

    expect(serialized).toBe(
      `${OAUTH_STATE_COOKIE}=opaque-state; Max-Age=600; Path=/api/v1/auth/oauth; HttpOnly; SameSite=Lax`,
    );
  });

  it('accepts only a callback state that matches the browser cookie', () => {
    const request = { headers: { cookie: `${OAUTH_STATE_COOKIE}=opaque-state` } };

    expect(readOAuthStateCookie(request)).toBe('opaque-state');
    expect(() => assertOAuthStateCookie(request, { state: 'opaque-state' })).not.toThrow();
    expect(() => assertOAuthStateCookie(request, { state: 'attacker-state' }))
      .toThrow(expect.objectContaining({ code: 'AUTH_OAUTH_STATE_INVALID' }));
  });

  it('rejects a callback without the initiating browser cookie', () => {
    expect(() => assertOAuthStateCookie({ headers: {} }, { state: 'opaque-state' }))
      .toThrow(expect.objectContaining({ code: 'AUTH_OAUTH_STATE_INVALID' }));
  });

  it('rejects ambiguous duplicate browser cookies', () => {
    const request = {
      headers: { cookie: `${OAUTH_STATE_COOKIE}=opaque-state; ${OAUTH_STATE_COOKIE}=other-state` },
    };

    expect(() => assertOAuthStateCookie(request, { state: 'opaque-state' }))
      .toThrow(expect.objectContaining({ code: 'AUTH_OAUTH_STATE_INVALID' }));
  });

  it('appends and clears the state cookie without exposing the state in the clear value', () => {
    const response = { append: (name: string, value: string) => calls.push([name, value]) };
    const calls: Array<[string, string]> = [];

    appendOAuthStateCookie(response, 'opaque-state', true);
    clearOAuthStateCookie(response, true);

    expect(calls).toEqual([
      [
        'Set-Cookie',
        `${OAUTH_STATE_COOKIE}=opaque-state; Max-Age=600; Path=/api/v1/auth/oauth; HttpOnly; SameSite=Lax; Secure`,
      ],
      [
        'Set-Cookie',
        `${OAUTH_STATE_COOKIE}=; Max-Age=0; Path=/api/v1/auth/oauth; HttpOnly; SameSite=Lax; Secure`,
      ],
    ]);
  });
});
