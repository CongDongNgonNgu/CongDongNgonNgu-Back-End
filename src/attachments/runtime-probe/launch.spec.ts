import { createProbeLauncher } from "./launch";
const sha = "b".repeat(40),
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
const config = {
  environment: "test",
  port: 10000,
  attachments: { enabled: false, image: false, video: false, text: false },
};
describe("cold default and one-shot explicit launch", () => {
  it("never imports the probe on default or invalid identity", async () => {
    const load = jest.fn(),
      launch = createProbeLauncher(load);
    await launch({}, config, "linux", "x64", []);
    expect(load).not.toHaveBeenCalled();
    await expect(
      launch({ ...env, RENDER_GIT_BRANCH: "main" }, config, "linux", "x64", []),
    ).rejects.toThrow("PHASE30_PROBE_GUARD");
    expect(load).not.toHaveBeenCalled();
  });
  it("admits once even when the first operation fails; never silently retries", async () => {
    const runRuntimeSmoke = jest.fn(async () => {
        throw Error("PHASE30_PROBE_HEALTH");
      }),
      load = jest.fn(async () => ({ runRuntimeSmoke })),
      launch = createProbeLauncher(load);
    await expect(launch(env, config, "linux", "x64", [])).rejects.toThrow(
      "PHASE30_PROBE_HEALTH",
    );
    await expect(launch(env, config, "linux", "x64", [])).rejects.toThrow(
      "PHASE30_PROBE_ALREADY_STARTED",
    );
    expect(load).toHaveBeenCalledTimes(1);
    expect(runRuntimeSmoke).toHaveBeenCalledTimes(1);
  });
});
