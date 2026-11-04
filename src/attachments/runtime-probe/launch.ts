import { probeIdentity, type ProbeConfiguration } from "./guard";
type Identity = NonNullable<ReturnType<typeof probeIdentity>>;
type Loader = () => Promise<{
  runRuntimeSmoke(identity: Identity): Promise<void>;
}>;
/** The loader stays cold by default; a valid explicit request is single-use. */
export function createProbeLauncher(load: Loader = () => import("./run")) {
  let started = false;
  return async (
    env: NodeJS.ProcessEnv,
    config: ProbeConfiguration,
    platform: string,
    arch: string,
    execArgv: readonly string[],
  ) => {
    const identity = probeIdentity(env, config, platform, arch, execArgv);
    if (!identity) return;
    if (started) throw Error("PHASE30_PROBE_ALREADY_STARTED");
    started = true;
    const probe = await load();
    await probe.runRuntimeSmoke(identity);
  };
}
export const launchRuntimeSmoke = createProbeLauncher();
