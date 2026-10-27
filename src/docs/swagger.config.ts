import type { RuntimeEnvironment } from "../config/env.validation";
export interface SwaggerConfig {
  enabled: boolean;
  username?: string;
  password?: string;
  trustLoopbackProxy: boolean;
}
export function parseSwaggerConfig(
  input: Record<string, unknown>,
  environment: RuntimeEnvironment,
): SwaggerConfig {
  const flag = input.SWAGGER_ENABLED ?? "false";
  if (flag !== "true" && flag !== "false")
    throw new Error("SWAGGER_ENABLED must be true or false");
  if (flag === "false") return { enabled: false, trustLoopbackProxy: false };
  const proxy = input.SWAGGER_TRUST_PROXY ?? "false";
  if (proxy !== "false" && proxy !== "loopback")
    throw new Error("SWAGGER_TRUST_PROXY must be false or loopback");
  const username = input.SWAGGER_USERNAME;
  const password = input.SWAGGER_PASSWORD;
  const configured = username !== undefined || password !== undefined;
  if (environment === "production" || configured) {
    if (
      typeof username !== "string" ||
      !username.length ||
      username.length > 128 ||
      !/^[-a-zA-Z0-9_.@]+$/.test(username) ||
      typeof password !== "string" ||
      password.length < 24 ||
      password.length > 256 ||
      /[\x00-\x1f\x7f]/.test(password) ||
      !password.trim()
    ) {
      throw new Error(
        "Swagger documentation credentials require a username and a separate password of 24-256 characters",
      );
    }
    let databasePassword: string | undefined;
    try {
      if (typeof input.DATABASE_URL === "string")
        databasePassword = decodeURIComponent(
          new URL(input.DATABASE_URL).password,
        );
    } catch {
      /* Existing database validator handles invalid URLs. */
    }
    if (
      [
        input.JWT_ACCESS_SECRET,
        input.JWT_REFRESH_SECRET,
        input.SESSION_SECRET,
        databasePassword,
      ].some(
        (value) =>
          typeof value === "string" && value.length > 0 && password === value,
      )
    )
      throw new Error(
        "Swagger documentation credentials must be separate from application and database secrets",
      );
    return {
      enabled: true,
      username,
      password,
      trustLoopbackProxy: proxy === "loopback",
    };
  }
  return { enabled: true, trustLoopbackProxy: proxy === "loopback" };
}
