import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module";
import { configureApp } from "./app.setup";
import { launchRuntimeSmoke } from "./attachments/runtime-probe/launch";
import type { RuntimeConfig } from "./config/configuration";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  configureApp(app);
  const config = app.get(ConfigService<RuntimeConfig, true>);
  await app.listen(config.get("app.port", { infer: true }));
  // Explicit TEST diagnostics only. Default startup never imports the probe.
  void launchRuntimeSmoke(process.env, {
    environment: config.get("app.environment", { infer: true }),
    port: config.get("app.port", { infer: true }),
    attachments: config.get("attachments", { infer: true }),
  }, process.platform, process.arch, process.execArgv).catch(() => {
    console.error('PHASE30_RUNTIME_SMOKE={"scope":"BASIC_PROCESSOR_RUNTIME_SMOKE_ONLY","status":"REJECTED","code":"PHASE30_PROBE_GUARD"}');
  });
}

void bootstrap();
