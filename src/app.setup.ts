import { configureSwagger } from './docs/swagger.setup';
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { RuntimeConfig } from "./config/configuration";
import { ApiExceptionFilter } from "./common/http/api-exception.filter";

import type { RequestHandler } from 'express';
export interface AppSetupOptions {
  /** Trusted bootstrap injection before init/listen; accounting grants no product capability. */
  attachmentRequestAccounting?: RequestHandler;
  /** Explicit diagnostic apps must disable Nest built-in parsers and supply accounting first. */
  attachmentBodyParser?: RequestHandler;
}
export function configureApp(app: INestApplication, options: AppSetupOptions = {}): void {
  const config = app.get(ConfigService<RuntimeConfig, true>);
  const origins = config.get("app.corsOrigins", { infer: true });
  const environment = config.get("app.environment", { infer: true });

  app.setGlobalPrefix("api/v1");
  app.enableCors({
    origin: origins,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Disposition'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Room-Access-Token', 'Last-Event-ID', 'Range'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new ApiExceptionFilter());
  app.use((_request: unknown, response: { setHeader: (name: string, value: string) => void }, next: () => void) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'");
    if (environment === "production") {
      response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });
  // app.use runs before Nest installs body parsers during init/listen. Module
  // route middleware is too late for conservative pre-parser accounting.
  if (options.attachmentRequestAccounting) app.use(options.attachmentRequestAccounting);
  if (options.attachmentBodyParser) {
    if (!options.attachmentRequestAccounting) throw Error('ATTACHMENT_DIAGNOSTIC_PARSER_REQUIRES_ACCOUNTING');
    app.use(options.attachmentBodyParser);
  }
  configureSwagger(app);
}
