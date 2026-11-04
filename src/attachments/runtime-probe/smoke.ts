import type { CgroupSample } from "./resources";
export interface StageResult {
  workerRssBytes: number;
  normalizedBytes: number;
  thumbnailBytes: number;
}
export interface SmokeJob {
  name: string;
  run(signal: AbortSignal): Promise<StageResult>;
  stop(): Promise<void>;
}
interface Observations {
  sample(): Promise<CgroupSample>;
  health(signal: AbortSignal): Promise<number>;
  rss(): number;
  record?(value: object): void;
}
export function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(Error("PHASE30_PROBE_ABORTED"));
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => {});
    if (signal.aborted) abort();
  });
}
export async function boundedShutdown(work: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Error("PHASE30_PROBE_SHUTDOWN_UNVERIFIED")),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
export async function executeSmoke(
  jobs: SmokeJob[],
  io: Observations,
  signal: AbortSignal,
) {
  if (
    jobs.length < 1 ||
    jobs.length > 4 ||
    new Set(jobs.map((job) => job.name)).size !== jobs.length ||
    jobs.some((job) => !["jpeg", "png", "webp", "video"].includes(job.name))
  )
    throw Error("PHASE30_PROBE_GUARD");
  if (signal.aborted) throw Error("PHASE30_PROBE_ABORTED");
  const first = await abortable(io.sample(), signal);
  if (first.limit > 512 * 1048576)
    throw Error("PHASE30_PROBE_RESOURCE_UNVERIFIED");
  let cgroupPeakBytes = first.current,
    appPeakRssBytes = 0;
  const checkedSample = async () => {
    if (signal.aborted) throw Error("PHASE30_PROBE_ABORTED");
    const sample = await abortable(io.sample(), signal);
    if (
      sample.limit !== first.limit ||
      sample.oom !== first.oom ||
      sample.oomKill !== first.oomKill ||
      (sample.ancestors ?? []).length !== (first.ancestors ?? []).length ||
      (sample.ancestors ?? []).some((ancestor, index) => {
        const initial = first.ancestors![index];
        return (
          ancestor.limit !== initial.limit ||
          ancestor.oom !== initial.oom ||
          ancestor.oomKill !== initial.oomKill
        );
      })
    )
      throw Error("PHASE30_PROBE_RESOURCE_UNVERIFIED");
    cgroupPeakBytes = Math.max(cgroupPeakBytes, sample.current);
    appPeakRssBytes = Math.max(appPeakRssBytes, io.rss());
    // Conservative diagnostic admission margin; never changes a media limit.
    if (
      [sample, ...(sample.ancestors ?? [])].some(
        (group) => group.current > Math.floor(group.limit * 0.75),
      )
    )
      throw Error("PHASE30_PROBE_HEADROOM");
    return sample;
  };
  await checkedSample();
  const baselineHealthMs: number[] = [];
  for (let i = 0; i < 3; i++) baselineHealthMs.push(await io.health(signal));
  io.record?.({
    event: "baseline",
    baselineHealthMs,
    cgroupBytes: first.current,
    cgroupLimitBytes: first.limit,
    appRssBytes: io.rss(),
    oom: first.oom,
    oomKill: first.oomKill,
  });
  const stages: {
    name: string;
    elapsedMs: number;
    healthMs: number[];
    result: StageResult;
  }[] = [];
  for (const job of jobs) {
    await checkedSample();
    const healthMs: number[] = [],
      started = performance.now();
    let done = false;
    const work = Promise.resolve().then(() => {
      if (signal.aborted) throw Error("PHASE30_PROBE_ABORTED");
      return job.run(signal);
    });
    const outcome = work.then((result) => ({
      result,
      elapsedMs: performance.now() - started,
    }));
    void outcome
      .finally(() => {
        done = true;
      })
      .catch(() => {});
    try {
      for (let count = 0; !done; count++) {
        await checkedSample();
        if (count < 8) healthMs.push(await io.health(signal));
        if (done) break;
        await abortable(
          new Promise<void>((resolve) => setTimeout(resolve, 100)),
          signal,
        );
      }
      const completed = await abortable(outcome, signal);
      if (
        Object.values(completed.result).some(
          (value) => !Number.isSafeInteger(value) || value < 1,
        ) ||
        completed.result.workerRssBytes > 192 * 1048576
      )
        throw Error("PHASE30_PROBE_RESOURCE_UNVERIFIED");
      stages.push({ name: job.name, ...completed, healthMs });
    } finally {
      await boundedShutdown(job.stop());
    }
    await checkedSample();
    io.record?.({
      event: "stage",
      ...stages[stages.length - 1],
      cgroupPeakBytes,
      appPeakRssBytes,
    });
  }
  await checkedSample();
  return {
    baselineHealthMs,
    stages,
    cgroupPeakBytes,
    appPeakRssBytes,
    cgroupLimitBytes: first.limit,
    oomDelta: 0,
    oomKillDelta: 0,
  };
}
