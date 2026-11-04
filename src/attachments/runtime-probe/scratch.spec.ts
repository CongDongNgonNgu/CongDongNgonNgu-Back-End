import { ScratchDirectory, type ScratchIO } from "./scratch";
const root = "phase30-runtime-smoke-owned";
const makeIO = (): ScratchIO => ({
  create: jest.fn(async () => root),
  protect: jest.fn(async () => {}),
  entries: jest.fn(async () => []),
  removeEmpty: jest.fn(async () => {}),
});
describe("bounded exact-owned scratch", () => {
  it("aborts stalled creation and disposes a late empty root without recursion", async () => {
    const io = makeIO(),
      abort = new AbortController();
    let settle!: (value: string) => void;
    io.create = jest.fn(
      () =>
        new Promise<string>((resolve) => {
          settle = resolve;
        }),
    );
    const owner = new ScratchDirectory(io, 20),
      opening = owner.open(abort.signal);
    abort.abort();
    await expect(opening).rejects.toThrow("PHASE30_PROBE_ABORTED");
    settle(root);
    await new Promise<void>((done) => setImmediate(done));
    expect(io.removeEmpty).toHaveBeenCalledWith(root);
  });
  it("bounds stalled cleanup and retains unresolved ownership", async () => {
    const io = makeIO(),
      owner = new ScratchDirectory(io, 10);
    await owner.open(new AbortController().signal);
    io.entries = jest.fn(() => new Promise(() => {}));
    expect(await owner.cleanup()).toBe(false);
    expect(io.removeEmpty).not.toHaveBeenCalled();
  });
  it("never removes a nonempty root or treats it as zero residual", async () => {
    const io = makeIO(),
      owner = new ScratchDirectory(io, 20);
    await owner.open(new AbortController().signal);
    io.entries = jest.fn(async () => ["unquiesced-child"]);
    expect(await owner.cleanup()).toBe(false);
    expect(io.removeEmpty).not.toHaveBeenCalled();
  });
  it("bounds successful-path verification by the global cancellation signal", async () => {
    const io = makeIO(),
      owner = new ScratchDirectory(io, 20),
      abort = new AbortController();
    await owner.open(abort.signal);
    io.entries = jest.fn(() => new Promise(() => {}));
    const closing = owner.close(abort.signal);
    abort.abort();
    await expect(closing).rejects.toThrow("PHASE30_PROBE_ABORTED");
    expect(io.removeEmpty).not.toHaveBeenCalled();
  });
});
