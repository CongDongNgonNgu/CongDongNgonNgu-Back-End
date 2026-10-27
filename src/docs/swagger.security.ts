import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { SwaggerConfig } from "./swagger.config";

export function isDocumentationPath(path: string): boolean {
  let normalized: string;
  try {
    normalized = decodeURIComponent(path).toLowerCase();
  } catch {
    return false;
  }
  return ["/docs", "/docs-json", "/docs-yaml"].some(
    (prefix) => normalized === prefix || normalized.startsWith(prefix + "/"),
  );
}
export function isSecureDocumentationRequest(
  request: Pick<Request, "secure" | "socket" | "headers">,
  trustLoopbackProxy: boolean,
): boolean {
  if (request.secure) return true;
  const peer = request.socket.remoteAddress;
  return (
    trustLoopbackProxy &&
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer ?? "") &&
    request.headers["x-forwarded-proto"] === "https"
  );
}
const digest = (value: string) =>
  createHash("sha256").update(value, "utf8").digest();
export function documentationCredentialsMatch(
  header: string | undefined,
  username: string,
  password: string,
): boolean {
  let actualUsername = "",
    actualPassword = "";
  if (
    header &&
    header.length <= 8192 &&
    /^Basic [A-Za-z0-9+/]+={0,2}$/i.test(header)
  ) {
    const encoded = header.slice(6);
    if (encoded.length % 4 === 0) {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator >= 0) {
        actualUsername = decoded.slice(0, separator);
        actualPassword = decoded.slice(separator + 1);
      }
    }
  }
  // Hash both fields to equal-size buffers, and always compare both fields.
  const validUser = timingSafeEqual(digest(actualUsername), digest(username));
  const validPassword = timingSafeEqual(
    digest(actualPassword),
    digest(password),
  );
  return validUser && validPassword;
}
export const DOCS_CSP =
  "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";
export function swaggerSecurity(config: SwaggerConfig, environment: string) {
  if (
    config.enabled &&
    environment === "production" &&
    (!config.username || !config.password)
  )
    throw new Error("Production Swagger requires documentation credentials");
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!isDocumentationPath(request.path)) {
      next();
      return;
    }
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Robots-Tag", "noindex, nofollow");
    response.vary("Authorization");
    if (config.username && config.password) {
      if (!isSecureDocumentationRequest(request, config.trustLoopbackProxy)) {
        response
          .status(403)
          .json({
            success: false,
            error: {
              code: "DOCS_HTTPS_REQUIRED",
              message: "HTTPS required for documentation authentication",
            },
          });
        return;
      }
      if (
        !documentationCredentialsMatch(
          request.headers.authorization,
          config.username,
          config.password,
        )
      ) {
        response.setHeader(
          "WWW-Authenticate",
          'Basic realm="CongDongNgonNgu API docs", charset="UTF-8"',
        );
        response
          .status(401)
          .json({
            success: false,
            error: {
              code: "DOCS_AUTH_REQUIRED",
              message: "Documentation authentication required",
            },
          });
        return;
      }
    }
    response.setHeader("Content-Security-Policy", DOCS_CSP);
    next();
  };
}
