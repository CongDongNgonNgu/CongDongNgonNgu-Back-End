const BLOCKED_HOST_MARKERS = ["eduai", "giaoducso.org.vn"] as const;
const SECRET_KEYS = ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"] as const;

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
  REDIS_URL?: string;
  AI_PROVIDER: OptionalProvider;
  EMAIL_PROVIDER: OptionalProvider;
  STORAGE_PROVIDER: OptionalProvider;
  REALTIME_PROVIDER: OptionalProvider;
  PAYMENT_PROVIDER: OptionalProvider;
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

  const result: ValidatedEnvironment = {
    NODE_ENV: environment,
    PORT: port,
    PUBLIC_APP_URL: publicAppUrl,
    CORS_ALLOWED_ORIGINS: corsOrigins,
    DATABASE_URL: databaseUrl,
    JWT_ACCESS_SECRET: accessSecret,
    JWT_REFRESH_SECRET: refreshSecret,
    AI_PROVIDER: readProvider(input.AI_PROVIDER, "AI_PROVIDER"),
    EMAIL_PROVIDER: readProvider(input.EMAIL_PROVIDER, "EMAIL_PROVIDER"),
    STORAGE_PROVIDER: readProvider(input.STORAGE_PROVIDER, "STORAGE_PROVIDER"),
    REALTIME_PROVIDER: readProvider(input.REALTIME_PROVIDER, "REALTIME_PROVIDER"),
    PAYMENT_PROVIDER: readProvider(input.PAYMENT_PROVIDER, "PAYMENT_PROVIDER"),
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

function readSecret(value: unknown, name: (typeof SECRET_KEYS)[number]): string {
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
