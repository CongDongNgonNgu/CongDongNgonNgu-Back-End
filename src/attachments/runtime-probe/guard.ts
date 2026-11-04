export interface ProbeConfiguration {
  environment: string;
  port: number;
  attachments: {
    enabled: boolean;
    image: boolean;
    video: boolean;
    text: boolean;
  };
}
/** Pure admission: no module loading, files, subprocesses or network activity. */
export function probeIdentity(
  env: NodeJS.ProcessEnv,
  config: ProbeConfiguration,
  platform: string,
  arch: string,
  execArgv: readonly string[],
): { sha: string; port: number; suite: "tiny" | "boundary" } | null {
  const sha = env.PHASE30_TEST_RUNTIME_PROBE_SHA;
  if (sha === undefined) return null;
  const reject = (): never => {
    throw Error("PHASE30_PROBE_GUARD");
  };
  if (
    !/^[a-f0-9]{40}$/.test(sha) ||
    env.RENDER_GIT_COMMIT !== sha ||
    env.RENDER_GIT_BRANCH !== "dev" ||
    env.RENDER_SERVICE_ID !== "srv-dahnerh594qs73fp3420" ||
    env.NODE_ENV !== "test" ||
    platform !== "linux" ||
    arch !== "x64" ||
    config.environment !== "test" ||
    !Number.isSafeInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535
  )
    return reject();
  if (
    execArgv.length ||
    ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH"].some(
      (key) => env[key],
    )
  )
    return reject();
  if (
    [
      "ATTACHMENTS_ENABLED",
      "ATTACHMENTS_IMAGE_ENABLED",
      "ATTACHMENTS_VIDEO_ENABLED",
      "ATTACHMENTS_TEXT_ENABLED",
    ].some((key) => env[key] !== "false") ||
    !config.attachments ||
    (["enabled", "image", "video", "text"] as const).some(
      (key) => config.attachments[key] !== false,
    )
  )
    return reject();
  const suite = env.PHASE30_TEST_RUNTIME_PROBE_SUITE ?? "tiny";
  if (suite !== "tiny" && suite !== "boundary") return reject();
  return { sha, port: config.port, suite };
}
