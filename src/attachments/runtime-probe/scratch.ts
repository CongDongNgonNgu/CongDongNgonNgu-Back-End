import { mkdtemp, chmod, readdir, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abortable } from "./smoke";
export interface ScratchIO {
  create(): Promise<string>;
  protect(root: string): Promise<void>;
  entries(root: string): Promise<string[]>;
  removeEmpty(root: string): Promise<void>;
}
const actual: ScratchIO = {
  create: () => mkdtemp(join(tmpdir(), "phase30-runtime-smoke-")),
  protect: (root) => chmod(root, 0o700),
  entries: (root) => readdir(root),
  removeEmpty: (root) => rmdir(root),
};
/** Owns only the exact mkdtemp result. Removal is empty-only, never recursive. */
export class ScratchDirectory {
  private root: string | undefined;
  constructor(
    private readonly io: ScratchIO = actual,
    private readonly deadlineMs = 3000,
  ) {
    if (
      !Number.isSafeInteger(deadlineMs) ||
      deadlineMs < 1 ||
      deadlineMs > 3000
    )
      throw Error("PHASE30_PROBE_GUARD");
  }
  private async bounded<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(Error("PHASE30_PROBE_SHUTDOWN_UNVERIFIED")),
        this.deadlineMs,
      );
    });
    try {
      const operation = Promise.race([work, expiry]);
      return await (signal ? abortable(operation, signal) : operation);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async open(signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw Error("PHASE30_PROBE_ABORTED");
    let abandoned = false;
    const creation = this.io.create().then((root) => {
      this.root = root;
      if (abandoned || signal.aborted) {
        void this.cleanup();
        throw Error("PHASE30_PROBE_ABORTED");
      }
      return root;
    });
    try {
      const root = await this.bounded(creation, signal);
      await this.bounded(this.io.protect(root), signal);
      return root;
    } catch (error) {
      abandoned = true;
      throw error;
    }
  }
  async close(signal?: AbortSignal): Promise<void> {
    const root = this.root;
    if (!root) throw Error("PHASE30_PROBE_SHUTDOWN_UNVERIFIED");
    if ((await this.bounded(this.io.entries(root), signal)).length !== 0)
      throw Error("PHASE30_PROBE_SHUTDOWN_UNVERIFIED");
    await this.bounded(this.io.removeEmpty(root), signal);
    this.root = undefined;
  }
  async cleanup(): Promise<boolean> {
    if (!this.root) return false;
    try {
      await this.close();
      return true;
    } catch {
      return false;
    }
  }
}
