import type { OAuthProviderName } from '../../identity/identity.types';

export interface OAuthProviderRuntimeConfig {
  enabled: boolean;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  scopes: string[];
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl?: string;
}

export interface OAuthIdentity {
  provider: OAuthProviderName;
  subject: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  emailVerified: boolean;
}

export interface OAuthProviderAdapter {
  readonly provider: OAuthProviderName;
  readonly enabled: boolean;
  getAuthorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<OAuthIdentity>;
}
