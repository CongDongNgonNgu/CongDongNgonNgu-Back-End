import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { abortable } from "./smoke";
export const BOUNDARY_INPUTS = [
  {
    name: "jpeg",
    filename: "boundary.jpeg",
    mime: "image/jpeg",
    bytes: 3990972,
    sha256: "a19debbdeaa8233d49d3e3f773fd68055316c34862f616b5bf4f666591726341",
    width: 2000,
    height: 1500,
  },
  {
    name: "png",
    filename: "boundary.png",
    mime: "image/png",
    bytes: 3737468,
    sha256: "31b7d63b3f735e1323b3398ca0fbfe25f3cc494c665897c477db6e3b793d13fb",
    width: 2000,
    height: 1500,
  },
  {
    name: "webp",
    filename: "boundary.webp",
    mime: "image/webp",
    bytes: 3328396,
    sha256: "412f033091125932aaa9c3f2bfb2955c732ec237616885da5dcb07c265dc7e8a",
    width: 2000,
    height: 1500,
  },
  {
    name: "video",
    filename: "boundary.mp4",
    mime: "video/mp4",
    bytes: 2918996,
    sha256: "598f6d9aa585d9e2922bc28ef919960f6bd57ad14244051ba132e6ff97acfd98",
    width: 1280,
    height: 720,
    durationSeconds: 15,
  },
] as const;
export interface BoundaryInputHandle {
  stat(): Promise<{ regular: boolean; size: number }>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}
export interface BoundaryInputIO {
  open(filename: string): Promise<BoundaryInputHandle>;
}
const actual: BoundaryInputIO = {
  open: async (filename) => {
    // Called only by the Linux-only explicit diagnostic. No caller-controlled path.
    const handle = await open(
      join(__dirname, "assets", filename),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    return {
      stat: async () => {
        const s = await handle.stat();
        return { regular: s.isFile(), size: s.size };
      },
      read: (buffer, offset, length, position) =>
        handle.read(buffer, offset, length, position),
      close: () => handle.close(),
    };
  },
};
/** One fixed <=4MiB input, including an extra byte to detect append races. Never writes. */
export async function readBoundaryInput(
  name: string,
  signal: AbortSignal,
  io: BoundaryInputIO = actual,
  deadlineMs = 3000,
): Promise<Buffer> {
  const fixture = BOUNDARY_INPUTS.find((item) => item.name === name);
  if (
    !fixture ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > 3000
  )
    throw Error("PHASE30_PROBE_FIXTURE_UNVERIFIED");
  if (signal.aborted) throw Error("PHASE30_PROBE_ABORTED");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, deadlineMs);
  const check = () => {
    if (controller.signal.aborted) throw Error("PHASE30_PROBE_ABORTED");
  };
  const work = (async () => {
    const handle = await io.open(fixture.filename);
    try {
      check();
      const stat = await handle.stat();
      check();
      if (!stat.regular || stat.size !== fixture.bytes)
        throw Error("PHASE30_PROBE_FIXTURE_UNVERIFIED");
      const bytes = Buffer.alloc(fixture.bytes + 1);
      let count = 0;
      while (count < bytes.length) {
        check();
        const result = await handle.read(
          bytes,
          count,
          bytes.length - count,
          count,
        );
        check();
        if (
          !Number.isSafeInteger(result.bytesRead) ||
          result.bytesRead < 0 ||
          result.bytesRead > bytes.length - count
        )
          throw Error("PHASE30_PROBE_FIXTURE_UNVERIFIED");
        if (result.bytesRead === 0) break;
        count += result.bytesRead;
      }
      if (
        count !== fixture.bytes ||
        createHash("sha256").update(bytes.subarray(0, count)).digest("hex") !==
          fixture.sha256
      )
        throw Error("PHASE30_PROBE_FIXTURE_UNVERIFIED");
      return bytes.subarray(0, count);
    } finally {
      await handle.close();
    }
  })();
  try {
    return await abortable(work, controller.signal);
  } catch {
    throw Error(
      controller.signal.aborted
        ? "PHASE30_PROBE_ABORTED"
        : "PHASE30_PROBE_FIXTURE_UNVERIFIED",
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    controller.abort();
  }
}
