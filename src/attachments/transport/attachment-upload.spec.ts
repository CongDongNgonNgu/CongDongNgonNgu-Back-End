import { Readable } from "node:stream";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { withAttachmentUpload } from "./attachment-upload";
describe("bounded raw upload intake", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "phase30-upload-proof-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  it("hashes exact raw bytes and removes owned temporary files after consumption", async () => {
    const bytes = Buffer.from("synthetic bytes");
    const result = await withAttachmentUpload(
      Readable.from([bytes]),
      bytes.length,
      async (file) => {
        expect(file.sizeBytes).toBe(bytes.length);
        expect(file.sha256).toBe(
          createHash("sha256").update(bytes).digest("hex"),
        );
        return "consumed";
      },
      { temporaryRoot: root },
    );
    expect(result).toBe("consumed");
    expect(await readdir(root)).toEqual([]);
  });
  it.each([
    [Buffer.from("short"), "INTEGRITY"],
    [Buffer.from("synthetic bytes longer"), "LIMIT_EXCEEDED"],
  ] as const)(
    "rejects under/over reservation bytes without callback or residual",
    async (bytes, code) => {
      let called = false;
      await expect(
        withAttachmentUpload(
          Readable.from([bytes]),
          10,
          async () => {
            called = true;
          },
          { temporaryRoot: root },
        ),
      ).rejects.toMatchObject({ code });
      expect(called).toBe(false);
      expect(await readdir(root)).toEqual([]);
    },
  );
  it("destroys stalled streams at the idle bound and cleans the owned directory", async () => {
    const stream = new Readable({ read() {} });
    await expect(
      withAttachmentUpload(stream, 10, async () => {}, {
        temporaryRoot: root,
        idleMs: 20,
        totalMs: 100,
      }),
    ).rejects.toThrow("ATTACHMENT_UPLOAD_TIMEOUT");
    expect(stream.destroyed).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });
  it("cleans the owned directory when downstream storage fails", async () => {
    await expect(
      withAttachmentUpload(
        Readable.from([Buffer.from("123")]),
        3,
        async () => {
          throw Error("synthetic-storage-failure");
        },
        { temporaryRoot: root },
      ),
    ).rejects.toThrow("synthetic-storage-failure");
    expect(await readdir(root)).toEqual([]);
  });
  it("does not report success when cancellation arrives during provider consumption", async () => {
    const c = new AbortController();
    await expect(
      withAttachmentUpload(
        Readable.from([Buffer.from("123")]),
        3,
        async () => {
          c.abort();
          return "late-provider-success";
        },
        { temporaryRoot: root, signal: c.signal },
      ),
    ).rejects.toThrow("ATTACHMENT_UPLOAD_CANCELLED");
    expect(await readdir(root)).toEqual([]);
  });
  it("aborts input without claiming receipt or invoking downstream storage", async () => {
    const c = new AbortController(),
      stream = new Readable({ read() {} });
    const p = withAttachmentUpload(stream, 10, async () => {}, {
      temporaryRoot: root,
      signal: c.signal,
    });
    c.abort();
    await expect(p).rejects.toThrow("ATTACHMENT_UPLOAD_CANCELLED");
    expect(await readdir(root)).toEqual([]);
  });

  it("classifies an oversized declared raw reservation as a limit error without spooling", async () => {
    let called = false;
    await expect(
      withAttachmentUpload(
        Readable.from([Buffer.from("abc")]),
        4194305,
        async () => {
          called = true;
        },
        { temporaryRoot: root },
      ),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(called).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });
});
