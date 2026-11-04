import { lstat } from "node:fs/promises";
import {
  collectFailureObservations,
  verifyExactScratchAbsent,
  safeNativeFailureObservation,
} from "./failure-observations";
import type { probeIdentity } from "./guard";

import { resolve } from "node:path";
import { ImageProcessor } from "../processing/image-processor";
import {
  NativeVideoProcessor,
  VideoProcessingError,
} from "../video-processing/video-processor";
import { ScratchDirectory } from "./scratch";
import { selectRuntimeInputs } from "./inputs";
import { resourceReader } from "./resources";
import { observeHealth } from "./health";
import {
  abortable,
  boundedShutdown,
  executeSmoke,
  type SmokeJob,
} from "./smoke";
const SCOPE = "BASIC_PROCESSOR_RUNTIME_SMOKE_ONLY";
const SAFE_CODES = new Set([
  "PHASE30_PROBE_FIXTURE_UNVERIFIED",
  "PROCESSING_INVALID",
  "PROCESSING_TIMEOUT",
  "PROCESSING_MEMORY_LIMIT",
  "PROCESSING_CANCELLED",
  "PROCESSING_UNAVAILABLE",
  "PROCESSING_UNQUIESCED",
  "PHASE30_PROBE_ABORTED",
  "PHASE30_PROBE_RESOURCE_UNVERIFIED",
  "PHASE30_PROBE_HEADROOM",
  "PHASE30_PROBE_HEALTH",
  "PHASE30_PROBE_SHUTDOWN_UNVERIFIED",
]);
export async function runRuntimeSmoke(
  identity: NonNullable<ReturnType<typeof probeIdentity>>,
): Promise<void> {
  const abort = new AbortController();
  const scratch = new ScratchDirectory();
  let fixtureName: string | undefined;
  let readResources: Awaited<ReturnType<typeof resourceReader>> | undefined;
  let failed = false,
    scratchRemoved = false;
  let root: string | undefined,
    active: ImageProcessor | NativeVideoProcessor | undefined;
  const emit = (value: object) =>
    console.log(
      "PHASE30_RUNTIME_SMOKE=" +
        JSON.stringify({
          scope:
            identity.suite === "boundary" ? "NEAR_LIMIT_SYNTHETIC_ONLY" : SCOPE,
          sha: identity.sha,
          ...value,
        }),
    );
  const deadline = setTimeout(() => abort.abort(), 150000);
  let exitTimer: NodeJS.Timeout | undefined;
  const terminate = () => {
    abort.abort();
    exitTimer = setTimeout(() => process.exit(143), 5000);
    void boundedShutdown(active?.shutdown() ?? Promise.resolve())
      .catch(() => {})
      .finally(() => {
        if (exitTimer) clearTimeout(exitTimer);
        process.kill(process.pid, "SIGTERM");
      });
  };
  process.once("SIGTERM", terminate);
  try {
    const sample = await abortable(resourceReader(), abort.signal);
    readResources = sample;
    root = await scratch.open(abort.signal);
    const jobs: SmokeJob[] = selectRuntimeInputs(identity.suite).map(
      (fixture) => ({
        name: fixture.name,
        run: async (signal) => {
          fixtureName = fixture.name;
          emit({ event: "fixture-start", name: fixture.name });
          const bytes = await fixture.read(signal);
          if (fixture.name === "video") {
            const processor = new NativeVideoProcessor({
              processorsDirectory: resolve(__dirname, "../processors"),
              temporaryRoot: root!,
            });
            active = processor;
            const result = await processor.process(bytes, fixture, signal);
            if (
              !result.nativeRssObserved ||
              result.width !== fixture.width ||
              result.height !== fixture.height ||
              result.durationSeconds !== fixture.durationSeconds
            )
              throw Error("PHASE30_PROBE_RESOURCE_UNVERIFIED");
            return {
              workerRssBytes: result.peakRssBytes,
              normalizedBytes: result.normalized.length,
              thumbnailBytes: result.thumbnail.length,
            };
          }
          const processor = new ImageProcessor({ temporaryRoot: root! });
          active = processor;
          const result = await processor.process(bytes, fixture, signal);
          if (
            result.width !== fixture.width ||
            result.height !== fixture.height
          )
            throw Error("PHASE30_PROBE_RESOURCE_UNVERIFIED");
          return {
            workerRssBytes: result.peakRssBytes,
            normalizedBytes: result.normalized.length,
            thumbnailBytes: result.thumbnail.length,
          };
        },
        stop: async () => {
          await active?.shutdown();
          active = undefined;
        },
      }),
    );
    const result = await executeSmoke(
      jobs,
      {
        sample,
        health: (signal) => observeHealth(identity.port, signal),
        rss: () => process.memoryUsage().rss,
        record: emit,
      },
      abort.signal,
    );
    await scratch.close(abort.signal);
    scratchRemoved = true;
    if (!root || !(await verifyExactScratchAbsent(() => lstat(root!))))
      throw Error("PHASE30_PROBE_SHUTDOWN_UNVERIFIED");
    emit({
      status:
        identity.suite === "boundary"
          ? "PASS_BOUNDARY_FIXTURES_ONLY"
          : "PASS_TINY_FIXTURES_ONLY",
      ...result,
      scratchResidual: 0,
      completeEnablement: "NOT_RUN",
      deploymentHeadroom: "UNVERIFIED_HIDDEN_ANCESTORS",
    });
  } catch (error) {
    failed = true;
    abort.abort();
    const originalCode =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : error instanceof Error
          ? error.message
          : "";
    let quiesced =
      !(error instanceof VideoProcessingError && !error.producerQuiesced) &&
      originalCode !== "PHASE30_PROBE_SHUTDOWN_UNVERIFIED";
    let shutdownVerified = true;
    try {
      await boundedShutdown(active?.shutdown() ?? Promise.resolve());
    } catch {
      shutdownVerified = false;
      quiesced = false;
    }
    const safeCode = SAFE_CODES.has(originalCode)
      ? originalCode
      : "PHASE30_PROBE_FAILED";
    emit({
      status: "FAIL",
      code: shutdownVerified ? safeCode : "PHASE30_PROBE_SHUTDOWN_UNVERIFIED",
      originalFailureCode: safeCode,
      fixture: fixtureName ?? "UNASSIGNED",
      scratchCleanup: "UNVERIFIED",
      processorObservation:
        error instanceof VideoProcessingError
          ? safeNativeFailureObservation(error.observation)
          : null,
      completeEnablement: "NOT_RUN",
      deploymentHeadroom: "UNVERIFIED_HIDDEN_ANCESTORS",
    });
    const observed = await collectFailureObservations(
      {
        resources: readResources,
        rss: () => process.memoryUsage().rss,
        cleanup: async () => {
          if (!root) return false;
          const removed = scratchRemoved || (await scratch.cleanup());
          return (
            removed && (await verifyExactScratchAbsent(() => lstat(root!)))
          );
        },
      },
      quiesced,
    );
    emit({
      event: "post-shutdown-observations",
      producerQuiesced: quiesced,
      ...observed,
      completeEnablement: "NOT_RUN",
    });
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGTERM", terminate);
    // Finite, empty-only cleanup; late creation retains its own cleanup handler.
    if (!failed && !scratchRemoved) await scratch.cleanup();
  }
}
