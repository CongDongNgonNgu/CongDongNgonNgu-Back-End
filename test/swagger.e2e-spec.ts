import SwaggerParser from "@apidevtools/swagger-parser";
import { randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";
import { buildConfiguration } from "../src/config/configuration";
import { validateEnvironment } from "../src/config/env.validation";
import type { SwaggerConfig } from "../src/docs/swagger.config";
const username = "reader",
  password = randomBytes(32).toString("base64url");
const forbidden = [
  password,
  randomBytes(32).toString("base64url"),
  randomBytes(32).toString("base64url"),
];
async function makeApp(swagger: SwaggerConfig, production = false) {
  const config = buildConfiguration(
    validateEnvironment({
      NODE_ENV: "test",
      PORT: "3000",
      PUBLIC_APP_URL: "http://localhost:5173",
      CORS_ALLOWED_ORIGINS: "http://localhost:5173",
      DATABASE_URL:
        "postgresql://postgres:postgres@localhost:5432/swagger_test",
      JWT_ACCESS_SECRET: forbidden[1],
      JWT_REFRESH_SECRET: forbidden[2],
    }),
  );
  config.swagger = swagger;
  if (production) config.app.environment = "production";
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(config))
    .compile();
  const app = module.createNestApplication();
  try {
    configureApp(app);
    await app.init();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
describe("Swagger TEST routes and existing API boundaries", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await makeApp({ enabled: true, trustLoopbackProxy: false });
  });
  afterAll(async () => {
    await app?.close();
  });
  it("redirects root exactly to /docs", () =>
    request(app.getHttpServer())
      .get("/")
      .expect(302)
      .expect("Location", "/docs"));
  it("serves UI and local UI assets with a docs-only CSP", async () => {
    const ui = await request(app.getHttpServer()).get("/docs").expect(200);
    expect(ui.text).toContain("swagger-ui");
    expect(ui.headers["content-security-policy"]).toContain(
      "style-src 'self' 'unsafe-inline'",
    );
    expect(ui.headers["content-security-policy"]).not.toContain(
      "script-src 'self' 'unsafe-inline'",
    );
    for (const asset of [
      "swagger-ui.css",
      "swagger-ui-bundle.js",
      "swagger-ui-init.js",
      "swagger-ui-standalone-preset.js",
    ])
      await request(app.getHttpServer())
        .get("/docs/" + asset)
        .expect(200);
  });
  it("contains real versioned endpoints, schemas, parameters and JWT metadata", async () => {
    const { body: doc } = await request(app.getHttpServer())
      .get("/docs-json")
      .expect(200)
      .expect("Content-Type", /json/);
    expect(doc.openapi).toMatch(/^3\./);
    await SwaggerParser.validate(JSON.parse(JSON.stringify(doc)), {
      resolve: { external: false },
    });
    expect(doc.info).toMatchObject({
      title: "CongDongNgonNgu API",
      version: require("../package.json").version,
    });
    expect(Object.keys(doc.paths).length).toBeGreaterThan(100);
    for (const path of [
      "/api/v1/health",
      "/api/v1/auth/login",
      "/api/v1/profile",
      "/api/v1/languages",
      "/api/v1/study-groups",
      "/api/v1/attachments",
    ])
      expect(doc.paths[path]).toBeDefined();
    expect(Object.keys(doc.components.schemas).length).toBeGreaterThan(25);
    expect(doc.components.schemas.LoginDto.properties.email.type).toBe(
      "string",
    );
    expect(doc.components.schemas.LoginDto.properties.password.writeOnly).toBe(
      true,
    );
    expect(doc.paths["/api/v1/profile"].get.security).toContainEqual({
      bearer: [],
    });
    expect(doc.paths["/api/v1/auth/login"].post.security ?? []).toEqual([]);
    expect(doc.components.securitySchemes.bearer).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    const encoded = JSON.stringify(doc);
    for (const value of forbidden) expect(encoded).not.toContain(value);
  });
  it("keeps health, prefix, auth and API security headers unchanged", async () => {
    const health = await request(app.getHttpServer())
      .get("/api/v1/health")
      .expect(200);
    expect(health.body).toEqual({
      success: true,
      data: {
        status: "ok",
        service: "congdongngonngu-backend",
        environment: "test",
      },
      message: "OK",
    });
    expect(health.headers["content-security-policy"]).not.toContain(
      "unsafe-inline",
    );
    await request(app.getHttpServer()).get("/health").expect(404);
    await request(app.getHttpServer()).get("/api/v1/docs").expect(404);
    await request(app.getHttpServer()).get("/api/v1/docs-json").expect(404);
    await request(app.getHttpServer()).get("/api/v1/profile").expect(401);
    await request(app.getHttpServer())
      .get("/api/v1/profile")
      .auth(username, password)
      .expect(401);
  });
});
describe("Swagger disabled", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await makeApp({ enabled: false, trustLoopbackProxy: false });
  });
  afterAll(async () => {
    await app?.close();
  });
  it("does not expose redirect, UI, spec or assets", async () => {
    for (const path of [
      "/",
      "/docs",
      "/docs-json",
      "/docs-yaml",
      "/docs/swagger-ui-init.js",
      "/docs/swagger-ui.css",
    ])
      await request(app.getHttpServer()).get(path).expect(404);
    await request(app.getHttpServer()).get("/api/v1/health").expect(200);
  });
});
describe("Production Swagger protection (isolated local configuration)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await makeApp(
      { enabled: true, username, password, trustLoopbackProxy: true },
      true,
    );
  });
  afterAll(async () => {
    await app?.close();
  });
  const paths = [
    "/docs",
    "/docs/",
    "/docs-json",
    "/docs-yaml",
    "/DOCS-JSON/",
    "/docs/index.html",
    "/docs/swagger-ui-init.js",
    "/docs/swagger-ui.css",
    "/docs/swagger-ui-bundle.js",
    "/docs/docs/swagger-ui-init.js",
    "/docs/swagger-ui-standalone-preset.js",
    "/docs/favicon-32x32.png",
    "/docs/oauth2-redirect.html",
  ];
  it.each(paths)("rejects unauthenticated resource %s", async (path) => {
    const res = await request(app.getHttpServer())
      .get(path)
      .set("X-Forwarded-Proto", "https")
      .expect(401);
    expect(res.headers["www-authenticate"]).toMatch(/^Basic /);
    expect(res.headers["cache-control"]).toContain("no-store");
    for (const value of forbidden) expect(res.text).not.toContain(value);
    expect(res.text).not.toContain("openapi");
  });
  it("keeps Production root redirect public without exposing the spec", () =>
    request(app.getHttpServer())
      .get("/")
      .expect(302)
      .expect("Location", "/docs"));
  it("also protects HEAD specification requests", () =>
    request(app.getHttpServer())
      .head("/docs-json")
      .set("X-Forwarded-Proto", "https")
      .expect(401));
  it("requires HTTPS before challenging or accepting credentials", () =>
    request(app.getHttpServer())
      .get("/docs-json")
      .auth(username, password)
      .expect(403));
  it("rejects invalid credentials", () =>
    request(app.getHttpServer())
      .get("/docs-json")
      .set("X-Forwarded-Proto", "https")
      .auth(username, password + "x")
      .expect(401));
  it("accepts valid independent credentials for UI/spec/assets only", async () => {
    for (const path of [
      "/docs",
      "/docs-json",
      "/docs/swagger-ui-init.js",
      "/docs/swagger-ui.css",
    ]) {
      const res = await request(app.getHttpServer())
        .get(path)
        .set("X-Forwarded-Proto", "https")
        .auth(username, password)
        .expect(200);
      expect(res.headers["strict-transport-security"]).toContain(
        "max-age=31536000",
      );
      for (const value of forbidden) expect(res.text).not.toContain(value);
    }
    await request(app.getHttpServer())
      .get("/docs-yaml")
      .set("X-Forwarded-Proto", "https")
      .auth(username, password)
      .expect(404);
    await request(app.getHttpServer())
      .get("/api/v1/profile")
      .auth(username, password)
      .expect(401);
  });
  it("fails closed even when configuration validation is bypassed", async () => {
    await expect(
      makeApp({ enabled: true, trustLoopbackProxy: false }, true),
    ).rejects.toThrow("Production Swagger requires documentation credentials");
  });
});
