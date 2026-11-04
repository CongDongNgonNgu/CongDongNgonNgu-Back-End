import { probeIdentity } from "./guard";
const sha = "a".repeat(40);
const env = {
  PHASE30_TEST_RUNTIME_PROBE_SHA: sha,
  RENDER_GIT_COMMIT: sha,
  RENDER_GIT_BRANCH: "dev",
  RENDER_SERVICE_ID: "srv-dahnerh594qs73fp3420",
  NODE_ENV: "test",
  ATTACHMENTS_ENABLED: "false",
  ATTACHMENTS_IMAGE_ENABLED: "false",
  ATTACHMENTS_VIDEO_ENABLED: "false",
  ATTACHMENTS_TEXT_ENABLED: "false",
};
const config = {
  environment: "test",
  port: 10000,
  attachments: { enabled: false, image: false, video: false, text: false },
};
describe("explicit TEST runtime smoke admission", () => {
  it("does nothing by default, including on production", () => {
    expect(
      probeIdentity(
        {},
        { ...config, environment: "production" },
        "linux",
        "x64",
        [],
      ),
    ).toBeNull();
  });
  it("admits only exact TEST identity with effective disabled capabilities", () => {
    expect(probeIdentity(env, config, "linux", "x64", [])).toEqual({
      sha,
      port: 10000,
    });
  });
  it.each([
    "RENDER_GIT_COMMIT",
    "RENDER_GIT_BRANCH",
    "RENDER_SERVICE_ID",
    "NODE_ENV",
    "ATTACHMENTS_ENABLED",
    "ATTACHMENTS_IMAGE_ENABLED",
    "ATTACHMENTS_VIDEO_ENABLED",
    "ATTACHMENTS_TEXT_ENABLED",
    "PHASE30_TEST_RUNTIME_PROBE_SHA",
  ])("rejects changed %s without echoing input", (key) => {
    expect(() =>
      probeIdentity(
        { ...env, [key]: "private-invalid-input" },
        config,
        "linux",
        "x64",
        [],
      ),
    ).toThrow("PHASE30_PROBE_GUARD");
  });
  it("rejects platform, injected runtime options, missing or enabled effective config", () => {
    for (const [platform, arch] of [
      ["win32", "x64"],
      ["linux", "arm64"],
    ])
      expect(() => probeIdentity(env, config, platform, arch, [])).toThrow();
    for (const key of [
      "NODE_OPTIONS",
      "NODE_PATH",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
    ])
      expect(() =>
        probeIdentity(
          { ...env, [key]: "injected" },
          config,
          "linux",
          "x64",
          [],
        ),
      ).toThrow();
    expect(() =>
      probeIdentity(env, config, "linux", "x64", ["--inspect"]),
    ).toThrow();
    expect(() =>
      probeIdentity(
        env,
        { ...config, environment: "production" },
        "linux",
        "x64",
        [],
      ),
    ).toThrow();
    expect(() =>
      probeIdentity(
        env,
        { ...config, attachments: { ...config.attachments, enabled: true } },
        "linux",
        "x64",
        [],
      ),
    ).toThrow();
    for (const port of [0, 65536, NaN, 1.5])
      expect(() =>
        probeIdentity(env, { ...config, port }, "linux", "x64", []),
      ).toThrow();
  });
});

it("rejects missing effective capability keys even when another key replaces them", () => {
  const sha = "a".repeat(40),
    env = {
      PHASE30_TEST_RUNTIME_PROBE_SHA: sha,
      RENDER_GIT_COMMIT: sha,
      RENDER_GIT_BRANCH: "dev",
      RENDER_SERVICE_ID: "srv-dahnerh594qs73fp3420",
      NODE_ENV: "test",
      ATTACHMENTS_ENABLED: "false",
      ATTACHMENTS_IMAGE_ENABLED: "false",
      ATTACHMENTS_VIDEO_ENABLED: "false",
      ATTACHMENTS_TEXT_ENABLED: "false",
    };
  expect(() =>
    probeIdentity(
      env,
      {
        environment: "test",
        port: 10000,
        attachments: {
          enabled: false,
          image: false,
          video: false,
          foreign: false,
        } as unknown as typeof config.attachments,
      },
      "linux",
      "x64",
      [],
    ),
  ).toThrow("PHASE30_PROBE_GUARD");
});
