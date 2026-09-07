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

describe("validateEnvironment", () => {
  it("accepts independent local defaults with providers disabled", () => {
    expect(validateEnvironment(base)).toMatchObject({
      NODE_ENV: "test",
      PORT: 3000,
      AI_PROVIDER: "disabled",
      PAYMENT_PROVIDER: "disabled",
    });
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
    });
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
