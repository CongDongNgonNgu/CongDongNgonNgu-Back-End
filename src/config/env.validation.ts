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
  const publicAppUrl = readOrigin(input.PUBLIC_APP_URL, "PUBLIC_APP_URL");
  const corsOrigins = readOrigins(input.CORS_ALLOWED_ORIGINS);
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
    ? readConfiguredUrl(input, "EMAIL_API_URL", "EMAIL_PROVIDER")
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

  const result: ValidatedEnvironment = {
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
  return result;
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

function readOrigin(value: unknown, name: string): string {
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
  return origin.replace(/\/$/, "");
}

function readOrigins(value: unknown): string[] {
  const raw = requireString(value, "CORS_ALLOWED_ORIGINS");
  const origins = raw.split(",").map((item) => item.trim()).filter(Boolean);
  if (origins.length === 0) throw new Error("CORS_ALLOWED_ORIGINS must not be empty");
  return origins.map((origin) => readOrigin(origin, "CORS_ALLOWED_ORIGINS"));
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
): string {
  return readHttpUrl(readConfiguredValue(input, name, providerName), name);
}

function readHttpUrl(value: unknown, name: string): string {
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
