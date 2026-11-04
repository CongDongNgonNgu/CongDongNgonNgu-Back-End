import { createHash } from "node:crypto";

import { resolve } from "node:path";
import { ImageProcessor } from "../processing/image-processor";
import { NativeVideoProcessor } from "../video-processing/video-processor";
import { ScratchDirectory } from "./scratch";
import { SMOKE_FIXTURES } from "./fixtures";
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
export async function runRuntimeSmoke(identity: {
  sha: string;
  port: number;
}): Promise<void> {
  const abort = new AbortController();
  const scratch = new ScratchDirectory();
  let root: string | undefined,
    active: ImageProcessor | NativeVideoProcessor | undefined;
  const emit = (value: object) =>
    console.log(
      "PHASE30_RUNTIME_SMOKE=" +
        JSON.stringify({ scope: SCOPE, sha: identity.sha, ...value }),
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
    root = await scratch.open(abort.signal);
    const jobs: SmokeJob[] = SMOKE_FIXTURES.map((fixture) => ({
      name: fixture.name,
      run: async (signal) => {
        const bytes = Buffer.from(fixture.base64, "base64");
        if (createHash("sha256").update(bytes).digest("hex") !== fixture.sha256)
          throw Error("PHASE30_PROBE_RESOURCE_UNVERIFIED");
        if (fixture.name === "video") {
          const processor = new NativeVideoProcessor({
            processorsDirectory: resolve(__dirname, "../processors"),
            temporaryRoot: root!,
          });
          active = processor;
          const result = await processor.process(bytes, fixture, signal);
          if (
            !result.nativeRssObserved ||
            result.width !== 128 ||
            result.height !== 72 ||
            result.durationSeconds !== 0.5
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
        if (result.width !== 32 || result.height !== 24)
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
    }));
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
    emit({
      status: "PASS_TINY_FIXTURES_ONLY",
      ...result,
      scratchResidual: 0,
      completeEnablement: "NOT_RUN",
      deploymentHeadroom: "UNVERIFIED_HIDDEN_ANCESTORS",
    });
  } catch (error) {
    abort.abort();
    try {
      await boundedShutdown(active?.shutdown() ?? Promise.resolve());
    } catch {
      emit({
        status: "FAIL",
        code: "PHASE30_PROBE_SHUTDOWN_UNVERIFIED",
        scratchCleanup: "UNVERIFIED",
      });
      return;
    }
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : error instanceof Error
          ? error.message
          : "";
    emit({
      status: "FAIL",
      code: SAFE_CODES.has(code) ? code : "PHASE30_PROBE_FAILED",
      scratchCleanup: "UNVERIFIED",
      completeEnablement: "NOT_RUN",
      deploymentHeadroom: "UNVERIFIED_HIDDEN_ANCESTORS",
    });
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGTERM", terminate);
    // Finite, empty-only cleanup; late creation retains its own cleanup handler.
    await scratch.cleanup();
  }
}
