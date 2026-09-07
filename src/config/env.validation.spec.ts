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
});
