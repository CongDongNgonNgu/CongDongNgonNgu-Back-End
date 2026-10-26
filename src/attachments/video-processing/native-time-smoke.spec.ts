import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFile, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as memory from "./native-memory";
import { measureNativeTimeSmoke } from "./native-time";

describe("bounded build-only GNU time smoke supervision (mocked child, real owned scratch)", () => {
  let directory: string,
    child: EventEmitter & {
      pid: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
  beforeEach(() => {
    directory = "";
    child = Object.assign(new EventEmitter(), {
      pid: 123456,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    jest.spyOn(process, "kill").mockImplementation((pid, signal) => {
      expect(pid).toBe(-123456);
      if (signal === 0) throw Object.assign(Error(), { code: "ESRCH" });
      queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      return true;
    });
  });
  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (directory) {
      if (!directory.startsWith(join(tmpdir(), "phase30-time-smoke-")))
        throw Error("TEST_OWNERSHIP");
      await rm(directory, { recursive: true, force: true });
    }
  });
  function fixture(
    metric: string | undefined,
    output = "1048576",
  ): Promise<void> {
    let started: () => void;
    const ready = new Promise<void>((done) => {
      started = done;
    });
    jest.spyOn(childProcess, "spawn").mockImplementation(((
      executable: string,
      args: string[],
      options: childProcess.SpawnOptions,
    ) => {
      expect(executable).toBe("/approved/bin/time");
      expect(options.detached).toBe(true);
      expect(options.env).toEqual({ LANG: "C", LC_ALL: "C", TZ: "UTC" });
      directory = String(options.cwd);
      expect(args.slice(-3)).toEqual([
        process.execPath,
        "-e",
        "process.stdout.write(String(Buffer.alloc(1048576).length))",
      ]);
      started();
      if (metric !== undefined)
        void writeFile(args[args.indexOf("-o") + 1], metric).then(() => {
          child.stdout.emit("data", Buffer.from(output));
          child.emit("close", 0, null);
        });
      return child;
    }) as typeof childProcess.spawn);
    return ready;
  }
  it("requires an actual strict positive metric and closes its exact owned scratch after group absence", async () => {
    fixture("PHASE30_RSS_KIB=8192\n");
    expect(await measureNativeTimeSmoke("/approved/bin/time")).toBe(
      8 * 1024 * 1024,
    );
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(process.kill).toHaveBeenCalledWith(-123456, 0);
  });
  it("rejects a successful process without valid lifetime memory evidence", async () => {
    fixture("PHASE30_RSS_KIB=0\n");
    await expect(measureNativeTimeSmoke("/approved/bin/time")).rejects.toThrow(
      "PROCESSING_UNAVAILABLE",
    );
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("enforces its 5s timeout, kills only its group and requires closure before cleanup", async () => {
    jest.useFakeTimers();
    const ready = fixture(undefined),
      pending = measureNativeTimeSmoke("/approved/bin/time");
    const rejection = expect(pending).rejects.toThrow("PROCESSING_UNAVAILABLE");
    await ready;
    await jest.advanceTimersByTimeAsync(5000);
    await rejection;
    expect(process.kill).toHaveBeenCalledWith(-123456, "SIGKILL");
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("retains exact scratch and rejects when independent producer quiescence is uncertain", async () => {
    fixture("PHASE30_RSS_KIB=8192\n");
    jest.spyOn(memory, "waitForLinuxGroupExit").mockResolvedValue(false);
    await expect(measureNativeTimeSmoke("/approved/bin/time")).rejects.toThrow(
      "PROCESSING_UNQUIESCED",
    );
    expect((await lstat(directory)).isDirectory()).toBe(true);
  });
  it("bounds stdout and kills the exact group instead of accepting a truncated completion", async () => {
    fixture("PHASE30_RSS_KIB=8192\n", "x".repeat(65));
    await expect(measureNativeTimeSmoke("/approved/bin/time")).rejects.toThrow(
      "PROCESSING_UNAVAILABLE",
    );
    expect(process.kill).toHaveBeenCalledWith(-123456, "SIGKILL");
  });
});
