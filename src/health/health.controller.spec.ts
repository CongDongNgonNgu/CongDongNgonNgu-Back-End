import { describe, expect, it } from "@jest/globals";
import { HealthController } from "./health.controller";

describe("HealthController", () => {
  it("reports the independent service identity and environment", () => {
    const controller = new HealthController({
      get: () => "test",
    } as never);

    expect(controller.check()).toEqual({
      success: true,
      data: {
        status: "ok",
        service: "congdongngonngu-backend",
        environment: "test",
      },
      message: "OK",
    });
  });
});
