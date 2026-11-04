import { createHash } from "node:crypto";
import { SMOKE_FIXTURES } from "./fixtures";
import { BOUNDARY_INPUTS, readBoundaryInput } from "./boundary-inputs";
export interface RuntimeInput {
  name: "jpeg" | "png" | "webp" | "video";
  filename: string;
  mime: string;
  width: number;
  height: number;
  durationSeconds?: number;
  read(signal: AbortSignal): Promise<Buffer>;
}
/** Selection allocates no media buffers and performs no filesystem/native work. */
export function selectRuntimeInputs(
  suite: "tiny" | "boundary",
): RuntimeInput[] {
  if (suite === "boundary")
    return BOUNDARY_INPUTS.map((input) => ({
      ...input,
      read: (signal: AbortSignal) => readBoundaryInput(input.name, signal),
    }));
  if (suite !== "tiny") throw Error("PHASE30_PROBE_GUARD");
  return SMOKE_FIXTURES.map((input) => ({
    name: input.name,
    filename: input.filename,
    mime: input.mime,
    width: input.name === "video" ? 128 : 32,
    height: input.name === "video" ? 72 : 24,
    durationSeconds: input.name === "video" ? 0.5 : undefined,
    read: async (signal: AbortSignal) => {
      if (signal.aborted) throw Error("PHASE30_PROBE_ABORTED");
      const bytes = Buffer.from(input.base64, "base64");
      if (createHash("sha256").update(bytes).digest("hex") !== input.sha256)
        throw Error("PHASE30_PROBE_FIXTURE_UNVERIFIED");
      return bytes;
    },
  }));
}
