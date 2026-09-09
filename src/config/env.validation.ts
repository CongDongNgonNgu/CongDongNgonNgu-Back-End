const BLOCKED_HOST_MARKERS = ["eduai", "giaoducso.org.vn"] as const;

export type RuntimeEnvironment = "development" | "test" | "production";
export type OptionalProvider = "disabled" | "configured";

export interface ValidatedEnvironment {
  NODE_ENV: RuntimeEnvironment;
  PORT: number;
  PUBLIC_APP_URL: string;
  CORS_ALLOWED_ORIGINS: string[];
  DATABASE_URL: string;
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;
  SESSION_STORE: OptionalProvider;
  SESSION_SECRET?: string;
  OAUTH_PROVIDER: OptionalProvider;
  OAUTH_CLIENT_ID?: string;
  OAUTH_CLIENT_SECRET?: string;
  OAUTH_REDIRECT_URI?: string;
  REDIS_URL?: string;
  AI_PROVIDER: OptionalProvider;
  AI_API_URL?: string;
  AI_API_KEY?: string;
  EMAIL_PROVIDER: OptionalProvider;
  EMAIL_API_URL?: string;
  EMAIL_API_KEY?: string;
  STORAGE_PROVIDER: OptionalProvider;
  STORAGE_API_URL?: string;
  STORAGE_ACCESS_KEY_ID?: string;
  STORAGE_SECRET_ACCESS_KEY?: string;
  STORAGE_BUCKET?: string;
  REALTIME_PROVIDER: OptionalProvider;
  REALTIME_API_URL?: string;
  REALTIME_API_KEY?: string;
  PAYMENT_PROVIDER: OptionalProvider;
  PAYMENT_API_URL?: string;
  PAYMENT_API_KEY?: string;
  PAYMENT_WEBHOOK_SECRET?: string;
}

export function validateEnvironment(
  input: Record<string, unknown>,
): ValidatedEnvironment {
  const environment = readEnvironment(input.NODE_ENV);
  const port = readPort(input.PORT);
  const publicAppUrl = readOrigin(input.PUBLIC_APP_URL, "PUBLIC_APP_URL", environment === "production");
  const corsOrigins = readOrigins(input.CORS_ALLOWED_ORIGINS, environment === "production");
  const databaseUrl = readDatabaseUrl(input.DATABASE_URL);
  const accessSecret = readSecret(input.JWT_ACCESS_SECRET, "JWT_ACCESS_SECRET");
  const refreshSecret = readSecret(input.JWT_REFRESH_SECRET, "JWT_REFRESH_SECRET");

  if (environment === "production") {
    for (const [name, value] of Object.entries({
      JWT_ACCESS_SECRET: accessSecret,
      JWT_REFRESH_SECRET: refreshSecret,
    })) {
      if (isPlaceholderSecret(value)) {
        throw new Error(`${name} must be replaced before production startup`);
      }
    }
  }

  const sessionStore = readProvider(input.SESSION_STORE, "SESSION_STORE");
  const sessionSecret = sessionStore === "configured"
    ? readConfiguredSecret(input, "SESSION_SECRET", "SESSION_STORE")
    : undefined;

  const oauthProvider = readProvider(input.OAUTH_PROVIDER, "OAUTH_PROVIDER");
  const oauthClientId = oauthProvider === "configured"
    ? readConfiguredValue(input, "OAUTH_CLIENT_ID", "OAUTH_PROVIDER")
    : undefined;
  const oauthClientSecret = oauthProvider === "configured"
    ? readConfiguredSecret(input, "OAUTH_CLIENT_SECRET", "OAUTH_PROVIDER")
    : undefined;
  const oauthRedirectUri = oauthProvider === "configured"
    ? readConfiguredUrl(input, "OAUTH_REDIRECT_URI", "OAUTH_PROVIDER")
    : undefined;

  const aiProvider = readProvider(input.AI_PROVIDER, "AI_PROVIDER");
  const aiApiUrl = aiProvider === "configured"
    ? readConfiguredUrl(input, "AI_API_URL", "AI_PROVIDER")
    : undefined;
  const aiApiKey = aiProvider === "configured"
    ? readConfiguredSecret(input, "AI_API_KEY", "AI_PROVIDER")
    : undefined;

  const emailProvider = readProvider(input.EMAIL_PROVIDER, "EMAIL_PROVIDER");
  const emailApiUrl = emailProvider === "configured"
    ? readConfiguredUrl(input, "EMAIL_API_URL", "EMAIL_PROVIDER", environment === "production")
    : undefined;
  const emailApiKey = emailProvider === "configured"
    ? readConfiguredSecret(input, "EMAIL_API_KEY", "EMAIL_PROVIDER")
    : undefined;

  const storageProvider = readProvider(input.STORAGE_PROVIDER, "STORAGE_PROVIDER");
  const storageApiUrl = storageProvider === "configured"
    ? readConfiguredUrl(input, "STORAGE_API_URL", "STORAGE_PROVIDER")
    : undefined;
  const storageAccessKeyId = storageProvider === "configured"
    ? readConfiguredValue(input, "STORAGE_ACCESS_KEY_ID", "STORAGE_PROVIDER")
    : undefined;
  const storageSecretAccessKey = storageProvider === "configured"
    ? readConfiguredSecret(input, "STORAGE_SECRET_ACCESS_KEY", "STORAGE_PROVIDER")
    : undefined;
  const storageBucket = storageProvider === "configured"
    ? readConfiguredValue(input, "STORAGE_BUCKET", "STORAGE_PROVIDER")
    : undefined;

  const realtimeProvider = readProvider(input.REALTIME_PROVIDER, "REALTIME_PROVIDER");
  const realtimeApiUrl = realtimeProvider === "configured"
    ? readConfiguredUrl(input, "REALTIME_API_URL", "REALTIME_PROVIDER")
    : undefined;
  const realtimeApiKey = realtimeProvider === "configured"
    ? readConfiguredSecret(input, "REALTIME_API_KEY", "REALTIME_PROVIDER")
    : undefined;

  const paymentProvider = readProvider(input.PAYMENT_PROVIDER, "PAYMENT_PROVIDER");
  const paymentApiUrl = paymentProvider === "configured"
    ? readConfiguredUrl(input, "PAYMENT_API_URL", "PAYMENT_PROVIDER")
    : undefined;
  const paymentApiKey = paymentProvider === "configured"
    ? readConfiguredSecret(input, "PAYMENT_API_KEY", "PAYMENT_PROVIDER")
    : undefined;
  const paymentWebhookSecret = paymentProvider === "configured"
    ? readConfiguredSecret(input, "PAYMENT_WEBHOOK_SECRET", "PAYMENT_PROVIDER")
    : undefined;

  const result: Omit<
    ValidatedEnvironment,
    'AUTH_PERSISTENCE' | 'AUTH_ACCESS_TTL_SECONDS' | 'AUTH_REFRESH_TTL_SECONDS' | 'AUTH_OAUTH_PROVIDERS'
  > = {
    NODE_ENV: environment,
    PORT: port,
    PUBLIC_APP_URL: publicAppUrl,
    CORS_ALLOWED_ORIGINS: corsOrigins,
    DATABASE_URL: databaseUrl,
    JWT_ACCESS_SECRET: accessSecret,
    JWT_REFRESH_SECRET: refreshSecret,
    SESSION_STORE: sessionStore,
    OAUTH_PROVIDER: oauthProvider,
    AI_PROVIDER: aiProvider,
    EMAIL_PROVIDER: emailProvider,
    STORAGE_PROVIDER: storageProvider,
    REALTIME_PROVIDER: realtimeProvider,
    PAYMENT_PROVIDER: paymentProvider,
    ...(sessionSecret ? { SESSION_SECRET: sessionSecret } : {}),
    ...(oauthClientId ? { OAUTH_CLIENT_ID: oauthClientId } : {}),
    ...(oauthClientSecret ? { OAUTH_CLIENT_SECRET: oauthClientSecret } : {}),
    ...(oauthRedirectUri ? { OAUTH_REDIRECT_URI: oauthRedirectUri } : {}),
    ...(aiApiUrl ? { AI_API_URL: aiApiUrl } : {}),
    ...(aiApiKey ? { AI_API_KEY: aiApiKey } : {}),
    ...(emailApiUrl ? { EMAIL_API_URL: emailApiUrl } : {}),
    ...(emailApiKey ? { EMAIL_API_KEY: emailApiKey } : {}),
    ...(storageApiUrl ? { STORAGE_API_URL: storageApiUrl } : {}),
    ...(storageAccessKeyId ? { STORAGE_ACCESS_KEY_ID: storageAccessKeyId } : {}),
    ...(storageSecretAccessKey ? { STORAGE_SECRET_ACCESS_KEY: storageSecretAccessKey } : {}),
    ...(storageBucket ? { STORAGE_BUCKET: storageBucket } : {}),
    ...(realtimeApiUrl ? { REALTIME_API_URL: realtimeApiUrl } : {}),
    ...(realtimeApiKey ? { REALTIME_API_KEY: realtimeApiKey } : {}),
    ...(paymentApiUrl ? { PAYMENT_API_URL: paymentApiUrl } : {}),
    ...(paymentApiKey ? { PAYMENT_API_KEY: paymentApiKey } : {}),
    ...(paymentWebhookSecret ? { PAYMENT_WEBHOOK_SECRET: paymentWebhookSecret } : {}),
  };

  const redisUrl = optionalString(input.REDIS_URL);
  if (redisUrl) {
    assertIndependentUrl(redisUrl, "REDIS_URL");
    if (!/^rediss?:\/\//i.test(redisUrl)) {
      throw new Error("REDIS_URL must use redis or rediss");
    }
    result.REDIS_URL = redisUrl;
  }
  return Object.assign(result, buildAuthEnvironment(input, environment));
}

function readEnvironment(value: unknown): RuntimeEnvironment {
  const normalized = optionalString(value) ?? "development";
  if (normalized === "development" || normalized === "test" || normalized === "production") {
    return normalized;
  }
  throw new Error("NODE_ENV must be development, test, or production");
}

function readPort(value: unknown): number {
  const normalized = optionalString(value) ?? "3000";
  const port = Number(normalized);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

function readDatabaseUrl(value: unknown): string {
  const databaseUrl = requireString(value, "DATABASE_URL");
  assertIndependentUrl(databaseUrl, "DATABASE_URL");
  if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
    throw new Error("DATABASE_URL must use a PostgreSQL connection URL");
  }
  return databaseUrl;
}

function readOrigin(value: unknown, name: string, requireHttps = false): string {
  const origin = requireString(value, name);
  assertIndependentUrl(origin, name);
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`${name} must be a valid origin`);
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error(`${name} must be an origin without path, query, or credentials`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  if (requireHttps && url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS in production`);
  }
  return origin.replace(/\/$/, "");
}

function readOrigins(value: unknown, requireHttps = false): string[] {
  const raw = requireString(value, "CORS_ALLOWED_ORIGINS");
  const origins = raw.split(",").map((item) => item.trim()).filter(Boolean);
  if (origins.length === 0) throw new Error("CORS_ALLOWED_ORIGINS must not be empty");
  return origins.map((origin) => readOrigin(origin, "CORS_ALLOWED_ORIGINS", requireHttps));
}

function readSecret(value: unknown, name: string): string {
  const secret = requireString(value, name);
  if (secret.length < 32) throw new Error(`${name} must be at least 32 characters`);
  return secret;
}

function readProvider(value: unknown, name: string): OptionalProvider {
  const provider = optionalString(value) ?? "disabled";
  if (provider !== "disabled" && provider !== "configured") {
    throw new Error(`${name} must be disabled or configured`);
  }
  return provider;
}

function readConfiguredValue(
  input: Record<string, unknown>,
  name: string,
  providerName: string,
): string {
  const value = optionalString(input[name]);
  if (!value) throw new Error(`${name} is required when ${providerName} is configured`);
  if (isPlaceholderSecret(value)) {
    throw new Error(`${name} must be replaced when ${providerName} is configured`);
  }
  return value;
}

function readConfiguredSecret(
  input: Record<string, unknown>,
  name: string,
  providerName: string,
): string {
  return readConfiguredValue(input, name, providerName);
}

function readConfiguredUrl(
  input: Record<string, unknown>,
  name: string,
  providerName: string,
  requireHttps = false,
): string {
  return readHttpUrl(readConfiguredValue(input, name, providerName), name, requireHttps);
}

function readHttpUrl(value: unknown, name: string, requireHttps = false): string {
  const rawUrl = requireString(value, name);
  assertIndependentUrl(rawUrl, name);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  if (requireHttps && url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS in production`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not contain credentials, query, or fragment`);
  }
  return rawUrl.replace(/\/$/, "");
}

function requireString(value: unknown, name: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function assertIndependentUrl(value: string, name: string): void {
  const normalized = value.toLowerCase();
  if (BLOCKED_HOST_MARKERS.some((marker) => normalized.includes(marker))) {
    throw new Error(`${name} points to a blocked external-product host`);
  }
}

function isPlaceholderSecret(value: string): boolean {
  return /^(replace-with|change-me|example|test-secret)/i.test(value);
}
export type AuthPersistence = 'postgres' | 'memory';
export type OAuthProviderKey = 'google' | 'facebook' | 'zalo' | 'apple';

export interface ValidatedOAuthProvider {
  enabled: boolean;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  scopes: string[];
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl?: string;
}

export interface ValidatedEnvironment {
  AUTH_PERSISTENCE: AuthPersistence;
  AUTH_ACCESS_TTL_SECONDS: number;
  AUTH_REFRESH_TTL_SECONDS: number;
  AUTH_OAUTH_PROVIDERS: Record<OAuthProviderKey, ValidatedOAuthProvider>;
}

function buildAuthEnvironment(
  input: Record<string, unknown>,
  environment: RuntimeEnvironment,
): Pick<
  ValidatedEnvironment,
  'AUTH_PERSISTENCE' | 'AUTH_ACCESS_TTL_SECONDS' | 'AUTH_REFRESH_TTL_SECONDS' | 'AUTH_OAUTH_PROVIDERS'
> {
  const persistence = readAuthPersistenceValue(input.AUTH_PERSISTENCE, environment);
  const accessTtlSeconds = readAuthDuration(input.AUTH_ACCESS_TTL_SECONDS, 'AUTH_ACCESS_TTL_SECONDS', 60, 3600, 900);
  const refreshTtlSeconds = readAuthDuration(input.AUTH_REFRESH_TTL_SECONDS, 'AUTH_REFRESH_TTL_SECONDS', 86400, 7776000, 2592000);
  const providers = {
    google: readAuthOAuthProvider(input, 'GOOGLE', {
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
      scopes: ['openid', 'email', 'profile'],
    }, environment),
    facebook: readAuthOAuthProvider(input, 'FACEBOOK', {
      authorizationUrl: 'https://www.facebook.com/v20.0/dialog/oauth',
      tokenUrl: 'https://graph.facebook.com/v20.0/oauth/access_token',
      userInfoUrl: 'https://graph.facebook.com/me',
      scopes: ['email', 'public_profile'],
    }, environment),
    zalo: readAuthOAuthProvider(input, 'ZALO', {
      authorizationUrl: 'https://oauth.zaloapp.com/v4/permission',
      tokenUrl: 'https://oauth.zaloapp.com/v4/access_token',
      userInfoUrl: 'https://graph.zalo.me/v2.0/me',
      scopes: ['id', 'name', 'picture', 'email'],
    }, environment),
    apple: readAuthOAuthProvider(input, 'APPLE', {
      authorizationUrl: 'https://appleid.apple.com/auth/authorize',
      tokenUrl: 'https://appleid.apple.com/auth/token',
      scopes: ['name', 'email'],
    }, environment),
  } satisfies Record<OAuthProviderKey, ValidatedOAuthProvider>;
  return {
    AUTH_PERSISTENCE: persistence,
    AUTH_ACCESS_TTL_SECONDS: accessTtlSeconds,
    AUTH_REFRESH_TTL_SECONDS: refreshTtlSeconds,
    AUTH_OAUTH_PROVIDERS: providers,
  };
}

function readAuthPersistenceValue(value: unknown, environment: RuntimeEnvironment): AuthPersistence {
  const persistence = optionalString(value) ?? (environment === 'test' ? 'memory' : 'postgres');
  if (persistence !== 'postgres' && persistence !== 'memory') {
    throw new Error('AUTH_PERSISTENCE must be postgres or memory');
  }
  if (environment === 'production' && persistence === 'memory') {
    throw new Error('AUTH_PERSISTENCE=memory is not allowed in production');
  }
  return persistence;
}

function readAuthDuration(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const normalized = optionalString(value);
  const duration = normalized === undefined ? fallback : Number(normalized);
  if (!Number.isInteger(duration) || duration < minimum || duration > maximum) {
    throw new Error(name + ' must be an integer between ' + minimum + ' and ' + maximum);
  }
  return duration;
}

function readAuthOAuthProvider(
  input: Record<string, unknown>,
  prefix: string,
  defaults: Pick<ValidatedOAuthProvider, 'authorizationUrl' | 'tokenUrl' | 'userInfoUrl' | 'scopes'>,
  environment: RuntimeEnvironment,
): ValidatedOAuthProvider {
  const provider = readProvider(input[prefix + '_OAUTH_PROVIDER'], prefix + '_OAUTH_PROVIDER');
  if (provider === 'disabled') {
    return { enabled: false, ...defaults };
  }
  const clientId = readConfiguredValue(input, prefix + '_OAUTH_CLIENT_ID', prefix + '_OAUTH_PROVIDER');
  const clientSecret = readConfiguredSecret(input, prefix + '_OAUTH_CLIENT_SECRET', prefix + '_OAUTH_PROVIDER');
  const redirectUri = readConfiguredUrl(
    input,
    prefix + '_OAUTH_REDIRECT_URI',
    prefix + '_OAUTH_PROVIDER',
    environment === 'production',
  );
  const scopes = optionalString(input[prefix + '_OAUTH_SCOPES'])
    ?.split(',')
    .map((scope) => scope.trim())
    .filter(Boolean) ?? defaults.scopes;
  return { ...defaults, enabled: true, clientId, clientSecret, redirectUri, scopes };
}
