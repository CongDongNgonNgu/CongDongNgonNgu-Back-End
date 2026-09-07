import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module";
import { configureApp } from "./app.setup";
import type { RuntimeConfig } from "./config/configuration";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  configureApp(app);
  const config = app.get(ConfigService<RuntimeConfig, true>);
  await app.listen(config.get("app.port", { infer: true }));
}

void bootstrap();
