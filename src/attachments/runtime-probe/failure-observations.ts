import { parseNativeProgress } from "../video-processing/native-progress";
import type { NativeFailureObservation } from "../video-processing/video-processor";
import type { CgroupSample } from "./resources";
interface FailureIO {
  resources?: () => Promise<CgroupSample>;
  rss(): number;
  cleanup?(): Promise<boolean>;
}
async function bounded<T>(
  work: () => Promise<T>,
  deadlineMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Error("PHASE30_OBSERVATION_UNVERIFIED")),
          deadlineMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function numericSample(input: CgroupSample): CgroupSample {
  const one = (s: Omit<CgroupSample, "ancestors">) => {
    if (
      !s ||
      ![s.current, s.limit, s.oom, s.oomKill].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) ||
      s.limit < 1
    )
      throw Error("PHASE30_OBSERVATION_UNVERIFIED");
    return {
      current: s.current,
      limit: s.limit,
      oom: s.oom,
      oomKill: s.oomKill,
    };
  };
  const sample = one(input);
  if (input.ancestors !== undefined) {
    if (!Array.isArray(input.ancestors) || input.ancestors.length > 64)
      throw Error("PHASE30_OBSERVATION_UNVERIFIED");
    return { ...sample, ancestors: input.ancestors.map(one) };
  }
  return sample;
}
/** Logical bounds only; late kernel filesystem work is not claimed cancelled. */
export async function collectFailureObservations(
  io: FailureIO,
  producerQuiesced: boolean,
  deadlineMs = 3000,
) {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 3000)
    throw Error("PHASE30_PROBE_GUARD");
  let resourceStatus: "OBSERVED" | "UNVERIFIED" = "UNVERIFIED",
    resource: CgroupSample | null = null,
    appRssBytes: number | null = null;
  if (io.resources)
    try {
      resource = numericSample(await bounded(io.resources, deadlineMs));
      resourceStatus = "OBSERVED";
      const rss = io.rss();
      appRssBytes = Number.isSafeInteger(rss) && rss > 0 ? rss : null;
    } catch {
      resourceStatus = "UNVERIFIED";
      resource = null;
    }
  let scratchStatus:
    "VERIFIED_ABSENT" | "UNVERIFIED" | "NOT_ATTEMPTED_PRODUCER_UNCERTAINTY" =
    producerQuiesced ? "UNVERIFIED" : "NOT_ATTEMPTED_PRODUCER_UNCERTAINTY";
  if (producerQuiesced && io.cleanup)
    try {
      if (await bounded(io.cleanup, deadlineMs))
        scratchStatus = "VERIFIED_ABSENT";
    } catch {
      /* Unknown remains unknown. */
    }
  return {
    resourceStatus,
    resource,
    appRssBytes,
    scratchStatus,
    scratchResidual:
      scratchStatus === "VERIFIED_ABSENT" ? 0 : ("UNVERIFIED" as const),
  };
}
/** Absence is only exact ENOENT; access errors and stalled reads remain unverified. */
export async function verifyExactScratchAbsent(
  check: () => Promise<unknown>,
  deadlineMs = 3000,
): Promise<boolean> {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 3000)
    throw Error("PHASE30_PROBE_GUARD");
  try {
    await bounded(check, deadlineMs);
    return false;
  } catch (error) {
    return (error as { code?: unknown })?.code === "ENOENT";
  }
}

export function safeNativeFailureObservation(
  input: unknown,
): NativeFailureObservation | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const v = input as Record<string, unknown>,
    keys = [
      "progress",
      "lastProgressAgeMs",
      "peakRssBytes",
      "nativeRssObserved",
    ];
  if (
    Object.keys(v).length !== keys.length ||
    Object.keys(v).some((k) => !keys.includes(k)) ||
    typeof v.nativeRssObserved !== "boolean"
  )
    return null;
  const progress = v.progress === null ? null : parseNativeProgress(v.progress);
  if (v.progress !== null && !progress) return null;
  if (
    v.lastProgressAgeMs !== null &&
    (typeof v.lastProgressAgeMs !== "number" ||
      !Number.isFinite(v.lastProgressAgeMs) ||
      v.lastProgressAgeMs < 0)
  )
    return null;
  if (
    v.peakRssBytes !== null &&
    (typeof v.peakRssBytes !== "number" ||
      !Number.isSafeInteger(v.peakRssBytes) ||
      v.peakRssBytes < 1)
  )
    return null;
  return {
    progress,
    lastProgressAgeMs: v.lastProgressAgeMs as number | null,
    peakRssBytes: v.peakRssBytes as number | null,
    nativeRssObserved: v.nativeRssObserved,
  };
}
