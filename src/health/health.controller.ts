import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { success, type ApiSuccess } from "../common/http/api-response";
import type { RuntimeConfig } from "../config/configuration";

interface HealthPayload {
  status: "ok";
  service: "congdongngonngu-backend";
  environment: "development" | "test" | "production";
}

@ApiTags("Health")
@ApiResponse({ status: 400, description: 'Request validation failed', schema: { $ref: '#/components/schemas/ApiError' } })
@Controller("health")
export class HealthController {
  constructor(private readonly config: ConfigService<RuntimeConfig, true>) {}

  @ApiOperation({ summary: "Check - Health" })
  @ApiResponse({ status: 200, description: 'Service identity and runtime environment', schema: {"type":"object","required":["success","data","message"],"properties":{"success":{"type":"boolean","enum":[true]},"data":{"type":"object","required":["status","service","environment"],"properties":{"status":{"type":"string","enum":["ok"]},"service":{"type":"string","enum":["congdongngonngu-backend"]},"environment":{"type":"string","enum":["development","test","production"]}}},"message":{"type":"string"}}} })
  @Get()
  check(): ApiSuccess<HealthPayload> {
    return success({
      status: "ok",
      service: "congdongngonngu-backend",
      environment: this.config.get("app.environment", { infer: true }),
    });
  }
}
