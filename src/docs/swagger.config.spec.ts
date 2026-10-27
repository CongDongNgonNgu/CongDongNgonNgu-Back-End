import { randomBytes } from "node:crypto";
import { parseSwaggerConfig } from "./swagger.config";
const password = () => randomBytes(32).toString("base64url");
describe("Swagger configuration", () => {
  it("defaults off and accepts explicit TEST docs without credentials", () => {
    expect(parseSwaggerConfig({}, "production")).toEqual({
      enabled: false,
      trustLoopbackProxy: false,
    });
    expect(parseSwaggerConfig({ SWAGGER_ENABLED: "true" }, "test")).toEqual({
      enabled: true,
      trustLoopbackProxy: false,
    });
  });
  it.each(["yes", "1", "TRUE", ""])(
    "rejects invalid enable flag %p",
    (SWAGGER_ENABLED) => {
      expect(() =>
        parseSwaggerConfig({ SWAGGER_ENABLED }, "production"),
      ).toThrow("SWAGGER_ENABLED");
    },
  );
  it("fails closed when enabled in Production without both credentials", () => {
    for (const fields of [
      {},
      { SWAGGER_USERNAME: "reader" },
      { SWAGGER_PASSWORD: password() },
    ])
      expect(() =>
        parseSwaggerConfig(
          { SWAGGER_ENABLED: "true", ...fields },
          "production",
        ),
      ).toThrow("Swagger documentation credentials");
  });
  it("rejects partial TEST credentials, weak passwords and invalid usernames", () => {
    for (const fields of [
      { SWAGGER_USERNAME: "reader" },
      { SWAGGER_USERNAME: "reader", SWAGGER_PASSWORD: "short" },
      { SWAGGER_USERNAME: "reader:other", SWAGGER_PASSWORD: password() },
    ])
      expect(() =>
        parseSwaggerConfig({ SWAGGER_ENABLED: "true", ...fields }, "test"),
      ).toThrow("Swagger documentation credentials");
  });
  it("rejects reused application secrets and database passwords", () => {
    for (const name of [
      "JWT_ACCESS_SECRET",
      "JWT_REFRESH_SECRET",
      "SESSION_SECRET",
    ]) {
      const secret = password();
      expect(() =>
        parseSwaggerConfig(
          {
            SWAGGER_ENABLED: "true",
            SWAGGER_USERNAME: "reader",
            SWAGGER_PASSWORD: secret,
            [name]: secret,
          },
          "production",
        ),
      ).toThrow("separate");
    }
    const secret = password();
    expect(() =>
      parseSwaggerConfig(
        {
          SWAGGER_ENABLED: "true",
          SWAGGER_USERNAME: "reader",
          SWAGGER_PASSWORD: secret,
          DATABASE_URL: "postgresql://test:" + secret + "@localhost/test",
        },
        "production",
      ),
    ).toThrow("separate");
  });
  it("accepts independent credentials and only explicit loopback proxy trust", () => {
    const secret = password();
    expect(
      parseSwaggerConfig(
        {
          SWAGGER_ENABLED: "true",
          SWAGGER_USERNAME: "reader",
          SWAGGER_PASSWORD: secret,
          SWAGGER_TRUST_PROXY: "loopback",
        },
        "production",
      ),
    ).toMatchObject({
      enabled: true,
      username: "reader",
      password: secret,
      trustLoopbackProxy: true,
    });
    expect(() =>
      parseSwaggerConfig(
        { SWAGGER_ENABLED: "true", SWAGGER_TRUST_PROXY: "true" },
        "test",
      ),
    ).toThrow("SWAGGER_TRUST_PROXY");
  });
});
