import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { Request, Response } from "express";
import type { RuntimeConfig } from "../config/configuration";
import { swaggerSecurity } from "./swagger.security";

export function configureSwagger(app: INestApplication): void {
  const config = app.get(ConfigService<RuntimeConfig, true>);
  const swagger = config.get("swagger", { infer: true });
  if (!swagger?.enabled) return;
  const environment = config.get("app.environment", { infer: true });
  app.use(swaggerSecurity(swagger, environment));
  const builder = new DocumentBuilder()
    .setTitle("CongDongNgonNgu API")
    .setDescription("API documentation for the CongDongNgonNgu platform.")
    .setVersion((require("../../package.json") as { version: string }).version)
    .addBearerAuth(
      { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      "bearer",
    )
    .addCookieAuth("cdn_refresh", { type: "apiKey", in: "cookie" }, "refresh")
    .build();
  const document = SwaggerModule.createDocument(app, builder);
  document.components ??= {};
  document.components.schemas ??= {};
  document.components.schemas.ApiSuccess = {
    type: "object",
    required: ["success", "data", "message"],
    properties: {
      success: { type: "boolean", enum: [true] },
      data: {},
      message: { type: "string" },
    },
  };
  document.components.schemas.ApiError = {
    type: "object",
    required: ["success", "error"],
    properties: {
      success: { type: "boolean", enum: [false] },
      error: {
        type: "object",
        required: ["code", "message"],
        properties: { code: { type: "string" }, message: { type: "string" } },
      },
    },
  };
  SwaggerModule.setup("docs", app, document, {
    useGlobalPrefix: false,
    jsonDocumentUrl: "/docs-json",
    raw: ["json"],
    customSiteTitle: "CongDongNgonNgu API",
    swaggerOptions: {
      persistAuthorization: false,
      queryConfigEnabled: false,
      validatorUrl: null,
      withCredentials: false,
      ...(environment === "production" ? { supportedSubmitMethods: [] } : {}),
    },
  });
  app
    .getHttpAdapter()
    .get("/", (_request: Request, response: Response) =>
      response.redirect(302, "/docs"),
    );
}
