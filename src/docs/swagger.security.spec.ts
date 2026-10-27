import { randomBytes } from "node:crypto";
import {
  documentationCredentialsMatch,
  isDocumentationPath,
  isSecureDocumentationRequest,
} from "./swagger.security";
const username = "reader",
  password = randomBytes(32).toString("base64url");
const header = (u: string, p: string) =>
  "Basic " + Buffer.from(u + ":" + p).toString("base64");
describe("documentation security boundaries", () => {
  it("compares both credentials and rejects malformed/oversized authorization", () => {
    expect(
      documentationCredentialsMatch(
        header(username, password),
        username,
        password,
      ),
    ).toBe(true);
    for (const value of [
      undefined,
      "Bearer x",
      header("wrong", password),
      header(username, password + "x"),
      "Basic !!!",
      "Basic " + "A".repeat(9000),
    ])
      expect(documentationCredentialsMatch(value, username, password)).toBe(
        false,
      );
  });
  it.each([
    "/docs",
    "/DOCS/",
    "/docs/index.html",
    "/docs/swagger-ui-init.js",
    "/docs-json",
    "/DOCS-JSON/",
    "/docs-yaml",
    "/d%6fcs/swagger-ui.css",
  ])("protects documentation path %s", (value) =>
    expect(isDocumentationPath(value)).toBe(true),
  );
  it.each(["/", "/api/v1/health", "/api/v1/docs", "/docs-other"])(
    "does not change API path %s",
    (value) => expect(isDocumentationPath(value)).toBe(false),
  );
  it("does not trust an arbitrary forwarded HTTPS header or implicit proxy trust", () => {
    const req = {
      secure: false,
      headers: { "x-forwarded-proto": "https" },
      socket: { remoteAddress: "198.51.100.5" },
    };
    expect(isSecureDocumentationRequest(req as never, true)).toBe(false);
    req.socket.remoteAddress = "127.0.0.1";
    expect(isSecureDocumentationRequest(req as never, false)).toBe(false);
    expect(isSecureDocumentationRequest(req as never, true)).toBe(true);
    req.headers["x-forwarded-proto"] = "https,http";
    expect(isSecureDocumentationRequest(req as never, true)).toBe(false);
  });
});
