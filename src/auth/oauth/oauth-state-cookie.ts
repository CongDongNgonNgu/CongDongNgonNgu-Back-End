import { timingSafeEqual } from 'node:crypto';
import { OAuthFailure } from './oauth.errors';

export const OAUTH_STATE_COOKIE = 'cdn_oauth_state';
export const OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 600;
export const OAUTH_STATE_COOKIE_PATH = '/api/v1/auth/oauth';

interface OAuthStateRequest {
  headers: {
    cookie?: string | string[];
  };
}

interface OAuthStateResponse {
  append(name: string, value: string): unknown;
}

export function readOAuthStateCookie(request: OAuthStateRequest): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (typeof cookieHeader !== 'string') return undefined;

  let matchCount = 0;
  let matchedValue: string | undefined;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0 || part.slice(0, separator).trim() !== OAUTH_STATE_COOKIE) continue;
    matchCount += 1;

    const encodedValue = part.slice(separator + 1).trim();
    if (!encodedValue) continue;

    try {
      const value = decodeURIComponent(encodedValue);
      if (value) matchedValue = value;
    } catch {
      // Treat malformed cookie values as invalid without reflecting them.
    }
  }

  return matchCount === 1 ? matchedValue : undefined;
}

export function assertOAuthStateCookie(
  request: OAuthStateRequest,
  query: { state?: unknown },
): void {
  const cookieState = readOAuthStateCookie(request);
  const queryState = typeof query.state === 'string' && query.state.length > 0 ? query.state : undefined;
  const cookieBytes = cookieState ? Buffer.from(cookieState) : undefined;
  const queryBytes = queryState ? Buffer.from(queryState) : undefined;

  if (
    !cookieBytes ||
    !queryBytes ||
    cookieBytes.length !== queryBytes.length ||
    !timingSafeEqual(cookieBytes, queryBytes)
  ) {
    throw new OAuthFailure('AUTH_OAUTH_STATE_INVALID', 400, 'OAuth browser state is invalid');
  }
}

export function serializeOAuthStateCookie(state: string, secure: boolean): string {
  return serializeCookie(encodeURIComponent(state), secure, OAUTH_STATE_COOKIE_MAX_AGE_SECONDS);
}

export function appendOAuthStateCookie(
  response: OAuthStateResponse,
  state: string,
  secure: boolean,
): void {
  response.append('Set-Cookie', serializeOAuthStateCookie(state, secure));
}

export function appendOAuthStateCookieFromAuthorizationUrl(
  response: OAuthStateResponse,
  authorizationUrl: string,
  secure: boolean,
): void {
  let state: string | null;
  try {
    state = new URL(authorizationUrl).searchParams.get('state');
  } catch {
    state = null;
  }
  if (!state) {
    throw new OAuthFailure('AUTH_OAUTH_STATE_INVALID', 400, 'OAuth authorization URL is invalid');
  }
  appendOAuthStateCookie(response, state, secure);
}

export function clearOAuthStateCookie(response: OAuthStateResponse, secure: boolean): void {
  response.append('Set-Cookie', serializeCookie('', secure, 0));
}

function serializeCookie(value: string, secure: boolean, maxAge: number): string {
  const attributes = [
    `${OAUTH_STATE_COOKIE}=${value}`,
    `Max-Age=${maxAge}`,
    `Path=${OAUTH_STATE_COOKIE_PATH}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}
