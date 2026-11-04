import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readBoundaryInput, type BoundaryInputIO } from "./boundary-inputs";
const bytes = readFileSync(join(__dirname, "assets/boundary.jpeg"));
function fixtureIO(data = bytes, stat = { regular: true, size: data.length }) {
  const close = jest.fn(async () => {});
  const read = jest.fn(
    async (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => {
      const n = Math.min(length, Math.max(0, data.length - position));
      data.copy(buffer, offset, position, position + n);
      return { bytesRead: n };
    },
  );
  const handle = { stat: async () => stat, read, close };
  const open = jest.fn(async () => handle);
  return { open, handle, close, read };
}
describe("bounded closed-inventory boundary input reader", () => {
  it("returns only hash-bound bytes and closes before successful return", async () => {
    const io = fixtureIO();
    expect(
      await readBoundaryInput("jpeg", new AbortController().signal, io),
    ).toEqual(bytes);
    expect(io.open).toHaveBeenCalledWith("boundary.jpeg");
    expect(io.read.mock.calls[0][0].length).toBe(bytes.length + 1);
    expect(io.close).toHaveBeenCalledTimes(1);
  });
  it("rejects unknown names and already-aborted requests before filesystem work", async () => {
    const io = fixtureIO(),
      controller = new AbortController();
    controller.abort();
    await expect(
      readBoundaryInput("../private", new AbortController().signal, io),
    ).rejects.toThrow("PHASE30_PROBE_FIXTURE_UNVERIFIED");
    await expect(
      readBoundaryInput("jpeg", controller.signal, io),
    ).rejects.toThrow("PHASE30_PROBE_ABORTED");
    expect(io.open).not.toHaveBeenCalled();
  });
  it.each([
    { regular: false, size: bytes.length },
    { regular: true, size: bytes.length + 1 },
    { regular: true, size: 2 ** 40 },
  ])(
    "rejects nonregular or unpinned size before allocation/read",
    async (stat) => {
      const io = fixtureIO(bytes, stat);
      await expect(
        readBoundaryInput("jpeg", new AbortController().signal, io),
      ).rejects.toThrow("PHASE30_PROBE_FIXTURE_UNVERIFIED");
      expect(io.read).not.toHaveBeenCalled();
      expect(io.close).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects corruption, truncation and appended bytes despite a matching preliminary stat", async () => {
    const changed = Buffer.from(bytes);
    changed[10] ^= 1;
    for (const data of [
      changed,
      bytes.subarray(0, bytes.length - 1),
      Buffer.concat([bytes, Buffer.from([0])]),
    ]) {
      const io = fixtureIO(data, { regular: true, size: bytes.length });
      await expect(
        readBoundaryInput("jpeg", new AbortController().signal, io),
      ).rejects.toThrow("PHASE30_PROBE_FIXTURE_UNVERIFIED");
      expect(io.close).toHaveBeenCalledTimes(1);
    }
  });
  it("bounds a stalled open and closes a late handle without reading", async () => {
    const io = fixtureIO();
    let late!: (value: Awaited<ReturnType<typeof io.open>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof io.open>>>(
      (resolve) => {
        late = resolve;
      },
    );
    const delayed: BoundaryInputIO = { open: () => pending };
    await expect(
      readBoundaryInput("jpeg", new AbortController().signal, delayed, 15),
    ).rejects.toThrow("PHASE30_PROBE_ABORTED");
    late(io.handle);
    await new Promise((resolve) => setImmediate(resolve));
    expect(io.read).not.toHaveBeenCalled();
    expect(io.close).toHaveBeenCalledTimes(1);
  });
  it("does not return or continue a late read after its deadline", async () => {
    const io = fixtureIO();
    let finish!: (value: { bytesRead: number }) => void;
    io.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await expect(
      readBoundaryInput("jpeg", new AbortController().signal, io, 15),
    ).rejects.toThrow("PHASE30_PROBE_ABORTED");
    finish({ bytesRead: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(io.read).toHaveBeenCalledTimes(1);
    expect(io.close).toHaveBeenCalledTimes(1);
  });
  it("sanitizes filesystem failures", async () => {
    await expect(
      readBoundaryInput("jpeg", new AbortController().signal, {
        open: async () => {
          throw Error("/private/path");
        },
      }),
    ).rejects.toThrow(/^PHASE30_PROBE_FIXTURE_UNVERIFIED$/);
  });
  it("bounds stalled stat and does not read when it eventually settles", async () => {
    const io = fixtureIO();
    let finish!: (value: { regular: boolean; size: number }) => void;
    io.handle.stat = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    await expect(
      readBoundaryInput("jpeg", new AbortController().signal, io, 15),
    ).rejects.toThrow("PHASE30_PROBE_ABORTED");
    finish({ regular: true, size: bytes.length });
    await new Promise((resolve) => setImmediate(resolve));
    expect(io.read).not.toHaveBeenCalled();
    expect(io.close).toHaveBeenCalledTimes(1);
  });
  it("does not return successful bytes while close is stalled", async () => {
    const io = fixtureIO();
    let finish!: () => void;
    io.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await expect(
      readBoundaryInput("jpeg", new AbortController().signal, io, 15),
    ).rejects.toThrow("PHASE30_PROBE_ABORTED");
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    expect(io.close).toHaveBeenCalledTimes(1);
  });
});
