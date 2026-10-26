import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
export class AttachmentUploadError extends Error {
  constructor(
    readonly code:
      "INTEGRITY" | "LIMIT_EXCEEDED" | "TIMEOUT" | "CANCELLED" | "UNAVAILABLE",
  ) {
    super("ATTACHMENT_UPLOAD_" + code);
    this.name = "AttachmentUploadError";
  }
}
export interface AttachmentUploadFile {
  path: string;
  sizeBytes: number;
  sha256: string;
}
interface Options {
  temporaryRoot?: string;
  signal?: AbortSignal;
  idleMs?: number;
  totalMs?: number;
}
/** Temporary spool only. The callback must await its actual provider operation.
 * This does not reserve quotas or authorize uploads, and no local path becomes durable.
 */
export async function withAttachmentUpload<T>(
  source: Readable,
  expectedBytes: number,
  consume: (file: AttachmentUploadFile) => Promise<T>,
  options: Options = {},
): Promise<T> {
  if (
    !(source instanceof Readable) ||
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 1
  )
    throw new AttachmentUploadError("INTEGRITY");
  if (expectedBytes > 4194304)
    throw new AttachmentUploadError("LIMIT_EXCEEDED");
  const idleMs = options.idleMs ?? 10000,
    totalMs = options.totalMs ?? 30000;
  if (
    !Number.isSafeInteger(idleMs) ||
    idleMs < 1 ||
    idleMs > 10000 ||
    !Number.isSafeInteger(totalMs) ||
    totalMs < 1 ||
    totalMs > 30000
  )
    throw new AttachmentUploadError("INTEGRITY");
  if (options.signal?.aborted) {
    source.destroy();
    throw new AttachmentUploadError("CANCELLED");
  }
  const root = resolve(options.temporaryRoot ?? tmpdir());
  let directory: string | undefined;
  const controller = new AbortController();
  let failure: AttachmentUploadError | undefined,
    idle: NodeJS.Timeout | undefined,
    total: NodeJS.Timeout | undefined;
  const stop = (code: AttachmentUploadError["code"]) => {
    failure ??= new AttachmentUploadError(code);
    controller.abort();
    source.destroy(failure);
  };
  const cancel = () => stop("CANCELLED");
  source.on("error", ignore);
  const resetIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => stop("TIMEOUT"), idleMs);
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    directory = await mkdtemp(join(root, "attachment-upload-"));
    await chmod(directory, 0o700);
    if (options.signal?.aborted) throw new AttachmentUploadError("CANCELLED");
    const path = join(directory, "source"),
      hash = createHash("sha256");
    let count = 0;
    const guard = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (!Buffer.isBuffer(chunk)) {
          callback(new AttachmentUploadError("INTEGRITY"));
          return;
        }
        if (count + chunk.length > expectedBytes) {
          callback(new AttachmentUploadError("LIMIT_EXCEEDED"));
          return;
        }
        count += chunk.length;
        hash.update(chunk);
        resetIdle();
        callback(null, chunk);
      },
      flush(callback) {
        callback(
          count === expectedBytes
            ? undefined
            : new AttachmentUploadError("INTEGRITY"),
        );
      },
    });
    resetIdle();
    total = setTimeout(() => stop("TIMEOUT"), totalMs);
    try {
      await pipeline(
        source,
        guard,
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
        { signal: controller.signal },
      );
    } catch (error) {
      if (failure) throw failure;
      if (error instanceof AttachmentUploadError) throw error;
      throw new AttachmentUploadError("UNAVAILABLE");
    }
    if (idle) clearTimeout(idle);
    if (total) clearTimeout(total);
    if (failure || options.signal?.aborted)
      throw failure ?? new AttachmentUploadError("CANCELLED");
    const result = await consume({
      path,
      sizeBytes: count,
      sha256: hash.digest("hex"),
    });
    if (failure || options.signal?.aborted)
      throw failure ?? new AttachmentUploadError("CANCELLED");
    return result;
  } finally {
    if (idle) clearTimeout(idle);
    if (total) clearTimeout(total);
    options.signal?.removeEventListener("abort", cancel);
    source.destroy();
    source.removeListener("error", ignore);
    if (directory) {
      const absolute = resolve(directory);
      if (
        !absolute.startsWith(root + sep) ||
        !absolute.startsWith(join(root, "attachment-upload-"))
      )
        throw new AttachmentUploadError("UNAVAILABLE");
      await rm(absolute, { recursive: true, force: true });
    }
  }
}
function ignore(): void {}
