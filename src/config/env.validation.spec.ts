import { describe, expect, it } from "@jest/globals";
import { validateEnvironment } from "./env.validation";

const base = {
  NODE_ENV: "test",
  PORT: "3000",
  PUBLIC_APP_URL: "http://localhost:5173",
  CORS_ALLOWED_ORIGINS: "http://localhost:5173",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/congdongngonngu",
  JWT_ACCESS_SECRET: "local-access-secret-that-is-at-least-32-chars",
  JWT_REFRESH_SECRET: "local-refresh-secret-that-is-at-least-32-chars",
};

describe('production transport security', () => {
  it('requires HTTPS for the public app origin in production', () => {
    expect(() => validateEnvironment({
      ...base,
      NODE_ENV: 'production',
      PUBLIC_APP_URL: 'http://app.example.test',
      CORS_ALLOWED_ORIGINS: 'https://app.example.test',
    })).toThrow('PUBLIC_APP_URL must use HTTPS in production');
  });

  it('requires HTTPS for production CORS origins', () => {
    expect(() => validateEnvironment({
      ...base,
      NODE_ENV: 'production',
      PUBLIC_APP_URL: 'https://app.example.test',
      CORS_ALLOWED_ORIGINS: 'http://app.example.test',
    })).toThrow('CORS_ALLOWED_ORIGINS must use HTTPS in production');
  });

  it('requires HTTPS for configured OAuth redirects and email delivery', () => {
    expect(() => validateEnvironment({
      ...base,
      NODE_ENV: 'production',
      PUBLIC_APP_URL: 'https://app.example.test',
      CORS_ALLOWED_ORIGINS: 'https://app.example.test',
      GOOGLE_OAUTH_PROVIDER: 'configured',
      GOOGLE_OAUTH_CLIENT_ID: 'google-client',
      GOOGLE_OAUTH_CLIENT_SECRET: 'google-secret',
      GOOGLE_OAUTH_REDIRECT_URI: 'http://auth.example.test/callback',
    })).toThrow('GOOGLE_OAUTH_REDIRECT_URI must use HTTPS in production');

    expect(() => validateEnvironment({
      ...base,
      NODE_ENV: 'production',
      PUBLIC_APP_URL: 'https://app.example.test',
      CORS_ALLOWED_ORIGINS: 'https://app.example.test',
      EMAIL_PROVIDER: 'configured',
      EMAIL_API_URL: 'http://mailer.example.test',
      EMAIL_API_KEY: 'email-key',
    })).toThrow('EMAIL_API_URL must use HTTPS in production');

    expect(() => validateEnvironment({
      ...base,
      NODE_ENV: 'production',
      PUBLIC_APP_URL: 'https://app.example.test',
      CORS_ALLOWED_ORIGINS: 'https://app.example.test',
      AI_PROVIDER: 'configured',
      AI_API_URL: 'http://ai.example.test',
      AI_API_KEY: 'ai-key',
    })).toThrow('AI_API_URL must use HTTPS in production');
  });
});

describe("validateEnvironment", () => {
  it("accepts independent local defaults with providers disabled", () => {
    expect(validateEnvironment(base)).toMatchObject({
      NODE_ENV: "test",
      PORT: 3000,
      AI_PROVIDER: "disabled",
      PAYMENT_PROVIDER: "disabled",
      PAYMENT_QR_ENABLED: false,
      AUTH_PERSISTENCE: "memory",
      AUTH_ACCESS_TTL_SECONDS: 900,
      AUTH_REFRESH_TTL_SECONDS: 2592000,
    });
  });

  it("rejects memory identity persistence in production", () => {
    expect(() => validateEnvironment({
      ...base,
      NODE_ENV: "production",
      PUBLIC_APP_URL: "https://app.example.test",
      CORS_ALLOWED_ORIGINS: "https://app.example.test",
      AUTH_PERSISTENCE: "memory",
    })).toThrow("AUTH_PERSISTENCE=memory is not allowed in production");
  });

  it("requires complete independent Google OAuth configuration", () => {
    expect(() => validateEnvironment({
      ...base,
      GOOGLE_OAUTH_PROVIDER: "configured",
      GOOGLE_OAUTH_CLIENT_ID: "google-client",
      GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:5173/api/v1/auth/oauth/google/callback",
    })).toThrow("GOOGLE_OAUTH_CLIENT_SECRET is required when GOOGLE_OAUTH_PROVIDER is configured");
  });

  it("rejects a database URL belonging to the external product", () => {
    expect(() => validateEnvironment({
      ...base,
      DATABASE_URL: "postgresql://user:password@eduai.example/congdong",
    })).toThrow("DATABASE_URL points to a blocked external-product host");
  });

  it("rejects credentials or paths in CORS origins", () => {
    expect(() => validateEnvironment({
      ...base,
      CORS_ALLOWED_ORIGINS: "https://user:password@example.test/app",
    })).toThrow("CORS_ALLOWED_ORIGINS must be an origin without path, query, or credentials");
  });

  it("rejects a Redis URL belonging to the external product", () => {
    expect(() => validateEnvironment({
      ...base,
      REDIS_URL: "redis://eduai.example:6379",
    })).toThrow("REDIS_URL points to a blocked external-product host");
  });

  it("rejects placeholder secrets in production", () => {
    expect(() => validateEnvironment({
      ...base,
      NODE_ENV: "production",
      PUBLIC_APP_URL: "https://app.example.test",
      CORS_ALLOWED_ORIGINS: "https://app.example.test",
      JWT_ACCESS_SECRET: "replace-with-a-local-random-access-secret",
    })).toThrow("JWT_ACCESS_SECRET must be replaced before production startup");
  });
  it("accepts independent provider controls while providers are disabled", () => {
    expect(validateEnvironment({
      ...base,
      SESSION_STORE: "disabled",
      OAUTH_PROVIDER: "disabled",
      AI_PROVIDER: "disabled",
      PAYMENT_PROVIDER: "disabled",
      PAYMENT_QR_ENABLED: "false",
      EMAIL_PROVIDER: "disabled",
      STORAGE_PROVIDER: "disabled",
      REALTIME_PROVIDER: "disabled",
    })).toMatchObject({
      SESSION_STORE: "disabled",
      OAUTH_PROVIDER: "disabled",
      AI_PROVIDER: "disabled",
      PAYMENT_PROVIDER: "disabled",
      EMAIL_PROVIDER: "disabled",
      STORAGE_PROVIDER: "disabled",
      REALTIME_PROVIDER: "disabled",
      PAYMENT_QR_ENABLED: false,
    });
  });

  it('accepts PayOS schema without exposing generic legacy payment fields', () => {
    expect(validateEnvironment({
      ...base,
      PAYMENT_PROVIDER: 'payos',
      PAYMENT_QR_ENABLED: 'true',
      PAYOS_API_URL: 'https://api-merchant.payos.vn',
      PAYOS_CLIENT_ID: 'client-id',
      PAYOS_API_KEY: 'api-key',
      PAYOS_CHECKSUM_KEY: 'checksum-key',
    })).toMatchObject({
      PAYMENT_PROVIDER: 'payos',
      PAYMENT_QR_ENABLED: true,
      PAYOS_API_URL: 'https://api-merchant.payos.vn',
      PAYOS_CLIENT_ID: 'client-id',
      PAYOS_API_KEY: 'api-key',
      PAYOS_CHECKSUM_KEY: 'checksum-key',
    });
  });

  it('rejects the legacy generic payment provider literal', () => {
    expect(() => validateEnvironment({
      ...base,
      PAYMENT_PROVIDER: 'configured',
    })).toThrow('PAYMENT_PROVIDER must be disabled or payos');
  });

  it('pins a configured PayOS endpoint to the official merchant host', () => {
    expect(() => validateEnvironment({
      ...base,
      PAYMENT_PROVIDER: 'payos',
      PAYOS_API_URL: 'https://payments.example.test',
    })).toThrow('PAYOS_API_URL must use api-merchant.payos.vn');
  });

  it('rejects an invalid payment QR flag instead of guessing its meaning', () => {
    expect(() => validateEnvironment({
      ...base,
      PAYMENT_QR_ENABLED: 'enabled',
    })).toThrow('PAYMENT_QR_ENABLED must be true or false');
  });

  it("accepts the TEST/UAT Resend and R2 provider literals", () => {
    expect(validateEnvironment({
      ...base,
      EMAIL_PROVIDER: "resend",
      EMAIL_API_URL: "https://api.resend.com/emails",
      EMAIL_FROM: "CongDongNgonNgu <onboarding@resend.dev>",
      EMAIL_API_KEY: "local-resend-key",
      STORAGE_PROVIDER: "r2",
      STORAGE_API_URL: "https://account-id.r2.cloudflarestorage.com",
      STORAGE_ACCESS_KEY_ID: "local-r2-access-key",
      STORAGE_SECRET_ACCESS_KEY: "local-r2-secret-key",
      STORAGE_BUCKET: "congdongngonngu",
    })).toMatchObject({
      EMAIL_PROVIDER: "resend",
      EMAIL_FROM: "CongDongNgonNgu <onboarding@resend.dev>",
      STORAGE_PROVIDER: "r2",
      STORAGE_BUCKET: "congdongngonngu",
    });
  });

  it("requires EMAIL_FROM for the Resend provider", () => {
    expect(() => validateEnvironment({
      ...base,
      EMAIL_PROVIDER: "resend",
      EMAIL_API_URL: "https://api.resend.com/emails",
      EMAIL_API_KEY: "local-resend-key",
    })).toThrow("EMAIL_FROM is required when EMAIL_PROVIDER is configured");
  });

  it("keeps Resend and R2 literal providers out of production", () => {
    expect(() => validateEnvironment({
      ...base,
      NODE_ENV: "production",
      PUBLIC_APP_URL: "https://app.example.test",
      CORS_ALLOWED_ORIGINS: "https://app.example.test",
      EMAIL_PROVIDER: "resend",
      EMAIL_API_URL: "https://api.resend.com",
      EMAIL_FROM: "CongDongNgonNgu <onboarding@resend.dev>",
      EMAIL_API_KEY: "local-resend-key",
    })).toThrow("EMAIL_PROVIDER=resend is TEST/UAT only");

    expect(() => validateEnvironment({
      ...base,
      NODE_ENV: "production",
      PUBLIC_APP_URL: "https://app.example.test",
      CORS_ALLOWED_ORIGINS: "https://app.example.test",
      STORAGE_PROVIDER: "r2",
      STORAGE_API_URL: "https://account-id.r2.cloudflarestorage.com",
      STORAGE_ACCESS_KEY_ID: "local-r2-access-key",
      STORAGE_SECRET_ACCESS_KEY: "local-r2-secret-key",
      STORAGE_BUCKET: "congdongngonngu",
    })).toThrow("STORAGE_PROVIDER=r2 is TEST/UAT only");
  });

  it("requires secure provider endpoints and pins named providers to their vendor hosts", () => {
    expect(() => validateEnvironment({
      ...base,
      EMAIL_PROVIDER: "resend",
      EMAIL_API_URL: "http://api.resend.com",
      EMAIL_FROM: "CongDongNgonNgu <onboarding@resend.dev>",
      EMAIL_API_KEY: "local-resend-key",
    })).toThrow("EMAIL_API_URL must use HTTPS");

    expect(() => validateEnvironment({
      ...base,
      EMAIL_PROVIDER: "resend",
      EMAIL_API_URL: "https://mailer.example.test",
      EMAIL_FROM: "CongDongNgonNgu <onboarding@resend.dev>",
      EMAIL_API_KEY: "local-resend-key",
    })).toThrow("EMAIL_API_URL must use api.resend.com");

    expect(() => validateEnvironment({
      ...base,
      STORAGE_PROVIDER: "r2",
      STORAGE_API_URL: "https://storage.example.test",
      STORAGE_ACCESS_KEY_ID: "local-r2-access-key",
      STORAGE_SECRET_ACCESS_KEY: "local-r2-secret-key",
      STORAGE_BUCKET: "congdongngonngu",
    })).toThrow("STORAGE_API_URL must use an R2 S3 endpoint");
  });

  it("rejects header injection in EMAIL_FROM before trimming", () => {
    expect(() => validateEnvironment({
      ...base,
      EMAIL_PROVIDER: "resend",
      EMAIL_API_URL: "https://api.resend.com",
      EMAIL_FROM: "\r\nCongDongNgonNgu <onboarding@resend.dev>",
      EMAIL_API_KEY: "local-resend-key",
    })).toThrow("EMAIL_FROM must be a single safe header value");
  });

  it("fails closed when a configured AI provider has no API key", () => {
    expect(() => validateEnvironment({
      ...base,
      AI_PROVIDER: "configured",
      AI_API_URL: "https://api.example.test",
    })).toThrow("AI_API_KEY is required when AI_PROVIDER is configured");
  });

  it("fails closed when a configured session store has no secret", () => {
    expect(() => validateEnvironment({
      ...base,
      SESSION_STORE: "configured",
    })).toThrow("SESSION_SECRET is required when SESSION_STORE is configured");
  });

  it("rejects an external-product provider endpoint", () => {
    expect(() => validateEnvironment({
      ...base,
      EMAIL_PROVIDER: "configured",
      EMAIL_API_URL: "https://eduai.example.test",
      EMAIL_API_KEY: "local-email-key",
    })).toThrow("EMAIL_API_URL points to a blocked external-product host");
  });
});
