import { OAuthFailure } from './oauth.errors';
import type {
  OAuthIdentity,
  OAuthProviderAdapter,
  OAuthProviderRuntimeConfig,
} from './oauth.types';

export class DisabledOAuthAdapter implements OAuthProviderAdapter {
  readonly enabled = false;

  constructor(
    readonly provider: OAuthIdentity['provider'],
    private readonly reason = 'Provider is disabled',
  ) {}

  getAuthorizationUrl(): string {
    throw new OAuthFailure('AUTH_PROVIDER_DISABLED', 503, this.reason);
  }

  async exchangeCode(): Promise<OAuthIdentity> {
    throw new OAuthFailure('AUTH_PROVIDER_DISABLED', 503, this.reason);
  }
}

export class GoogleOAuthAdapter implements OAuthProviderAdapter {
  readonly provider = 'google' as const;
  readonly enabled = true;

  constructor(private readonly config: OAuthProviderRuntimeConfig) {}

  getAuthorizationUrl(state: string): string {
    const url = new URL(this.config.authorizationUrl);
    url.searchParams.set('client_id', this.config.clientId!);
    url.searchParams.set('redirect_uri', this.config.redirectUri!);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', this.config.scopes.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', state);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'select_account');
    return url.toString();
  }

  async exchangeCode(code: string): Promise<OAuthIdentity> {
    const tokenResponse = await fetch(this.config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.config.clientId!,
        client_secret: this.config.clientSecret!,
        redirect_uri: this.config.redirectUri!,
        grant_type: 'authorization_code',
      }),
    }).catch(() => null);
    if (!tokenResponse || !tokenResponse.ok) {
      throw new OAuthFailure('AUTH_OAUTH_FAILED', 400, 'Không thể xác thực với Google');
    }
    const tokenPayload = await readJson(tokenResponse);
    const accessToken = readString(tokenPayload.access_token);
    if (!accessToken) throw new OAuthFailure('AUTH_OAUTH_FAILED', 400, 'Phản hồi Google không hợp lệ');
    const profileResponse = await fetch(this.config.userInfoUrl!, {
      headers: { Authorization: 'Bearer ' + accessToken },
    }).catch(() => null);
    if (!profileResponse || !profileResponse.ok) {
      throw new OAuthFailure('AUTH_OAUTH_FAILED', 400, 'Không thể đọc hồ sơ Google');
    }
    const profile = await readJson(profileResponse);
    const subject = readString(profile.sub);
    if (!subject) throw new OAuthFailure('AUTH_OAUTH_FAILED', 400, 'Hồ sơ Google thiếu định danh');
    return {
      provider: 'google',
      subject,
      email: readString(profile.email),
      displayName: readString(profile.name),
      avatarUrl: readString(profile.picture),
      emailVerified: profile.email_verified === true,
    };
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new OAuthFailure('AUTH_OAUTH_FAILED', 400, 'Phản hồi OAuth không hợp lệ');
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
