import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { success, type ApiSuccess } from "../common/http/api-response";
import type { RuntimeConfig } from "../config/configuration";

interface HealthPayload {
  status: "ok";
  service: "congdongngonngu-backend";
  environment: "development" | "test" | "production";
}

@Controller("health")
export class HealthController {
  constructor(private readonly config: ConfigService<RuntimeConfig, true>) {}

  @Get()
  check(): ApiSuccess<HealthPayload> {
    return success({
      status: "ok",
      service: "congdongngonngu-backend",
      environment: this.config.get("app.environment", { infer: true }),
    });
  }
}
